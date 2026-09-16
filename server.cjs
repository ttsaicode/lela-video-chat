require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");
const WebSocket = require("ws");
const formidable = require("formidable");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const supabase = require("./lib/supabase.cjs");
const redis = require("./lib/redis.cjs");

// Runtime Port & Host configuration
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = "0.0.0.0";

const publicDir = path.join(__dirname, "public");
const adminDir = path.join(__dirname, "admin");
const uploadsDir = path.join(__dirname, "uploads");

// Ensure required directories exist
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
if (!fs.existsSync(adminDir)) {
  fs.mkdirSync(adminDir, { recursive: true });
}

// ==================================================
// SECURITY & JWT CONFIGURATION
// ==================================================

const JWT_SECRET = process.env.JWT_SECRET || "lela_jwt_secret_2026_super_secure_key_99";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Role-Based Access Control (RBAC) Permission Matrix
const ROLE_PERMISSIONS = {
  superadmin: ["*"],
  admin: [
    "ads:read", "ads:write", "ads:delete",
    "reports:read", "reports:write",
    "bans:read", "bans:write",
    "clients:read", "clients:kick",
    "broadcast:send",
    "analytics:read",
    "logs:read"
  ],
  moderator: [
    "reports:read", "reports:write",
    "bans:read", "bans:write",
    "clients:read", "clients:kick",
    "broadcast:send",
    "ads:read"
  ],
  ads_manager: [
    "ads:read", "ads:write", "ads:delete",
    "analytics:read"
  ]
};

function hasPermission(role, requiredPermission) {
  if (!role || !ROLE_PERMISSIONS[role]) return false;
  const permissions = ROLE_PERMISSIONS[role];
  if (permissions.includes("*")) return true;
  return permissions.includes(requiredPermission);
}

// Token Blacklist for invalidated sessions on logout
const tokenBlacklist = new Set();

// Rate limiting for administrative login attempts (Brute-Force Protection)
const loginAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };

  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, error: `Too many failed attempts. Locked for ${remainingSeconds}s.` };
  }

  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    return { allowed: false, error: "Too many failed attempts. Account locked for 15 minutes." };
  }

  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now, lockedUntil: 0 };
  record.count += 1;
  loginAttempts.set(ip, record);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Helper: Client IP detection with proxy support
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket ? req.socket.remoteAddress : "unknown";
}

// Helper: JSON Body parser with size limit (DoS protection)
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error("Request body exceeds 1MB limit"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

// Helper: Verify JWT token from Authorization header
function verifyAdminToken(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || tokenBlacklist.has(token)) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { ...decoded, token };
  } catch (err) {
    return null;
  }
}

// Helper: Sanitize external URLs against XSS / protocol manipulation
function sanitizeUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return "";
  const trimmed = urlString.trim();
  if (/^(https?:\/\/|\/)/i.test(trimmed)) {
    return trimmed;
  }
  return "";
}

// Helper: Validate MIME types for uploaded media (Strict file validation)
const ALLOWED_UPLOAD_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm"
]);

const ALLOWED_UPLOAD_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".mp4", ".webm"
]);

// Track system start time for uptime & performance monitoring
const SERVER_START_TIME = Date.now();
let eventLoopLag = 0;
setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    eventLoopLag = Math.round((performance.now() - start) * 100) / 100;
  });
}, 2000);

// Maintenance mode & website updates announcement state
let activeAnnouncement = null;
const announcementHistory = [];

// ==================================================
// HTTP SERVER & ADMIN API
// ==================================================

const server = http.createServer(async (req, res) => {
  let requestPath = req.url.split("?")[0];

  // Helper for JSON responses with security headers
  const sendJson = (status, obj) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    res.end(JSON.stringify(obj));
  };

  // --------------------------------------------------
  // ADMIN DASHBOARD HTML & AUTH
  // --------------------------------------------------

  // Admin Dashboard page
  if (requestPath === "/admin" || requestPath === "/admin/") {
    const adminHtmlPath = path.join(adminDir, "index.html");
    fs.readFile(adminHtmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error loading admin dashboard");
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(data);
    });
    return;
  }

  // Admin Login with JWT issuance and Brute-Force lockout protection
  if (requestPath === "/api/admin/login" && req.method === "POST") {
    const clientIp = getClientIp(req);
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      return sendJson(429, { error: rateCheck.error });
    }

    try {
      const { username, password } = await parseJsonBody(req);
      if (!username || !password) {
        return sendJson(400, { error: "Username and password required" });
      }

      // Check database admins first, fallback to env ADMIN_USERNAME
      const dbAdmin = await supabase.getAdminByUsername(username);
      let isValidUser = false;
      let userRole = "admin";
      let adminId = "admin-root";
      let email = "admin@lela.chat";

      if (dbAdmin) {
        adminId = dbAdmin.id;
        userRole = dbAdmin.role || "admin";
        email = dbAdmin.email || `${username}@lela.chat`;

        if (dbAdmin.password_hash) {
          isValidUser = bcrypt.compareSync(password, dbAdmin.password_hash);
        } else if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
          isValidUser = true;
        }
      } else if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        isValidUser = true;
        userRole = "superadmin";
      }

      if (isValidUser) {
        resetLoginAttempts(clientIp);

        // Sign cryptographically verified JWT token
        const token = jwt.sign(
          {
            id: adminId,
            username,
            email,
            role: userRole,
            permissions: ROLE_PERMISSIONS[userRole] || []
          },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRY }
        );

        await supabase.logAction("ADMIN_LOGIN", { username, role: userRole, ip: clientIp }, adminId, clientIp);

        return sendJson(200, {
          success: true,
          token,
          user: {
            id: adminId,
            username,
            email,
            role: userRole,
            permissions: ROLE_PERMISSIONS[userRole] || []
          }
        });
      }

      recordFailedLogin(clientIp);
      return sendJson(401, { error: "Invalid username or password credentials" });
    } catch (e) {
      return sendJson(400, { error: e.message || "Login request error" });
    }
  }

  // Admin Logout (Invalidates JWT Session)
  if (requestPath === "/api/admin/logout" && req.method === "POST") {
    const admin = verifyAdminToken(req);
    if (admin && admin.token) {
      tokenBlacklist.add(admin.token);
      await supabase.logAction("ADMIN_LOGOUT", { username: admin.username }, admin.id, getClientIp(req));
    }
    return sendJson(200, { success: true, message: "Logged out successfully" });
  }

  // Admin Heartbeat for session liveness
  if (requestPath === "/api/admin/heartbeat" && req.method === "POST") {
    const admin = verifyAdminToken(req);
    if (!admin) return sendJson(401, { error: "Session expired" });
    return sendJson(200, { status: "active", user: admin });
  }

  // --------------------------------------------------
  // PROTECTED ADMIN API ROUTES (RBAC & JWT GUARD)
  // --------------------------------------------------

  if (requestPath.startsWith("/api/admin/")) {
    const admin = verifyAdminToken(req);
    if (!admin) {
      return sendJson(401, { error: "Unauthorized. Valid JWT token required." });
    }

    // GET /api/admin/me - Current Admin Profile
    if (requestPath === "/api/admin/me" && req.method === "GET") {
      return sendJson(200, { user: admin });
    }

    // GET /api/admin/stats - Overview Statistics
    if (requestPath === "/api/admin/stats" && req.method === "GET") {
      let activePairs = 0;
      const uniqueIps = new Set();
      for (const client of connectedClients) {
        if (client.peer) activePairs++;
        if (client.ip) uniqueIps.add(client.ip);
      }
      activePairs = Math.floor(activePairs / 2);

      const allReports = await supabase.getReports();
      const allBans = await supabase.getBans();
      const allAds = await supabase.getAds();
      const engagement = redis.getEngagementMetrics();

      const totalImpressions = allAds.reduce((acc, a) => acc + (Number(a.impressions) || 0), 0);
      const totalClicks = allAds.reduce((acc, a) => acc + (Number(a.clicks) || 0), 0);
      const overallCtr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + "%" : "0.00%";

      return sendJson(200, {
        onlineCount: uniqueIps.size,
        totalConnections: connectedClients.size,
        waitingCount: waitingClients.length,
        activePairsCount: activePairs,
        totalReports: allReports.length,
        pendingReports: allReports.filter(r => r.status === "pending").length,
        totalBans: allBans.length,
        totalAds: allAds.length,
        liveAds: allAds.filter(a => a.active).length,
        adImpressions: totalImpressions,
        adClicks: totalClicks,
        adCtr: overallCtr,
        engagementMetrics: engagement,
        redisConnected: redis.isRedisConfigured(),
        supabaseConnected: supabase.isSupabaseConfigured()
      });
    }

    // GET /api/admin/analytics/performance - Real-Time System Performance
    if (requestPath === "/api/admin/analytics/performance" && req.method === "GET") {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);

      return sendJson(200, {
        uptimeSeconds,
        uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
        memory: {
          rssMb: Math.round(memory.rss / (1024 * 1024)),
          heapTotalMb: Math.round(memory.heapTotal / (1024 * 1024)),
          heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
          externalMb: Math.round(memory.external / (1024 * 1024))
        },
        cpu: {
          userMs: Math.round(cpu.user / 1000),
          systemMs: Math.round(cpu.system / 1000)
        },
        eventLoopLagMs: eventLoopLag,
        connections: {
          webSocketCount: connectedClients.size,
          waitingQueue: waitingClients.length
        },
        nodeVersion: process.version
      });
    }

    // GET /api/admin/analytics/engagement - User Engagement Metrics
    if (requestPath === "/api/admin/analytics/engagement" && req.method === "GET") {
      const engagement = redis.getEngagementMetrics();
      const ads = await supabase.getAds();

      return sendJson(200, {
        engagement,
        topPerformingAds: ads.slice(0, 5).map(a => ({
          id: a.id,
          title: a.title,
          impressions: a.impressions,
          clicks: a.clicks,
          ctr: a.impressions > 0 ? ((a.clicks / a.impressions) * 100).toFixed(2) + "%" : "0%"
        }))
      });
    }

    // ==================================================
    // ADS MANAGEMENT (RBAC: requires ads:read / ads:write)
    // ==================================================

    // GET /api/admin/ads/settings - Retrieve global ad settings
    if (requestPath === "/api/admin/ads/settings" && req.method === "GET") {
      if (!hasPermission(admin.role, "ads:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to view ad settings." });
      }
      const settings = await supabase.getAdSettings();
      return sendJson(200, { settings });
    }

    // PUT /api/admin/ads/settings - Update global ad settings
    if (requestPath === "/api/admin/ads/settings" && req.method === "PUT") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to update ad settings." });
      }
      const body = await parseJsonBody(req);
      const updates = {};
      if (body.enabled !== undefined) updates.enabled = !!body.enabled;
      if (body.defaultPlacement !== undefined) updates.defaultPlacement = body.defaultPlacement;
      if (body.mobileDockStranger !== undefined) updates.mobileDockStranger = !!body.mobileDockStranger;
      if (body.rotationSeconds !== undefined) updates.rotationSeconds = Math.max(3, parseInt(body.rotationSeconds) || 12);
      if (body.allowDismiss !== undefined) updates.allowDismiss = !!body.allowDismiss;
      if (body.redisplayOnRotate !== undefined) updates.redisplayOnRotate = !!body.redisplayOnRotate;

      const updatedSettings = await supabase.updateAdSettings(updates);
      await supabase.logAction("AD_SETTINGS_UPDATE", { updates }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, settings: updatedSettings });
    }

    // GET /api/admin/ads - List all ads with metrics
    if (requestPath === "/api/admin/ads" && req.method === "GET") {
      if (!hasPermission(admin.role, "ads:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to view ads." });
      }
      const adsList = await supabase.getAds();
      const settings = await supabase.getAdSettings();
      return sendJson(200, { ads: adsList, settings });
    }

    // POST /api/admin/ads - Create New Ad (Handles Multipart or JSON)
    if (requestPath === "/api/admin/ads" && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to create ads." });
      }

      const form = new formidable.IncomingForm({
        uploadDir: uploadsDir,
        keepExtensions: true,
        maxFileSize: 25 * 1024 * 1024 // 25MB limit
      });

      form.parse(req, async (err, fields, files) => {
        if (err) {
          console.error("Ad upload error:", err);
          return sendJson(400, { error: "Upload failed: " + err.message });
        }

        const getVal = (v) => Array.isArray(v) ? v[0] : v;

        const title = (getVal(fields.title) || "").trim() || "Sponsored Announcement";
        const bodyText = (getVal(fields.body) || "").trim();
        const cta_text = (getVal(fields.cta_text) || "").trim().slice(0, 30) || "Learn more ↗";
        const device_target = getVal(fields.device_target) || "all";
        const link_url = sanitizeUrl(getVal(fields.link_url));
        const placement = getVal(fields.placement) || "stranger-overlay";
        const rotation_seconds = parseInt(getVal(fields.rotation_seconds)) || 12;
        const priority = parseInt(getVal(fields.priority)) || 1;
        const active = getVal(fields.active) === "true" || getVal(fields.active) === true;

        let mediaUrl = sanitizeUrl(getVal(fields.media_url));
        let mediaType = "image";

        // Validate uploaded file if present
        if (files.media && files.media.length > 0) {
          const file = files.media[0];
          const ext = path.extname(file.originalFilename || file.filepath).toLowerCase();
          const mime = file.mimetype;

          // Strict extension & mime validation patch
          if (!ALLOWED_UPLOAD_EXTS.has(ext) || !ALLOWED_UPLOAD_MIMES.has(mime)) {
            // Delete unsafe file immediately
            try { fs.unlinkSync(file.filepath); } catch (e) {}
            return sendJson(400, { error: `Invalid file type (${mime}). Only images (PNG, JPG, WEBP, GIF) and videos (MP4, WEBM) are permitted.` });
          }

          // Generate randomized secure filename to prevent path traversal & overwrites
          const safeFilename = "ad_" + crypto.randomBytes(16).toString("hex") + ext;
          const targetPath = path.join(uploadsDir, safeFilename);

          try {
            fs.renameSync(file.filepath, targetPath);
            mediaUrl = `/uploads/${safeFilename}`;
            mediaType = mime.startsWith("video/") ? "video" : "image";
          } catch (moveErr) {
            console.error("Error moving ad file:", moveErr);
            return sendJson(500, { error: "Could not save uploaded media" });
          }
        } else if (mediaUrl) {
          mediaType = mediaUrl.match(/\.(mp4|webm|ogg)$/i) ? "video" : "image";
        }

        if (!mediaUrl) {
          return sendJson(400, { error: "Media file or valid URL is required" });
        }

        const newAd = await supabase.addAd({
          title,
          body: bodyText,
          cta_text,
          device_target,
          media_url: mediaUrl,
          media_type: mediaType,
          link_url,
          placement,
          rotation_seconds,
          priority,
          active,
          created_by: admin.username
        });

        await supabase.logAction("AD_CREATE", { id: newAd.id, title, mediaUrl }, admin.id, getClientIp(req));
        return sendJson(201, { success: true, ad: newAd });
      });
      return;
    }

    // PUT /api/admin/ads/:id/status - Toggle Ad Status
    const adStatusMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/status$/);
    if (adStatusMatch && req.method === "PUT") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to modify ads." });
      }
      const adId = adStatusMatch[1];
      const { active } = await parseJsonBody(req);
      const updated = await supabase.updateAdStatus(adId, !!active);
      if (!updated) return sendJson(404, { error: "Ad not found" });

      await supabase.logAction("AD_STATUS_CHANGE", { adId, active: !!active }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ad: updated });
    }

    // PUT /api/admin/ads/:id - Full Ad Customization & Update
    const adUpdateMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)$/);
    if (adUpdateMatch && req.method === "PUT") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to modify ads." });
      }
      const adId = adUpdateMatch[1];
      const existingAd = await supabase.getAdById(adId);
      if (!existingAd) return sendJson(404, { error: "Ad not found" });

      const body = await parseJsonBody(req);
      const updates = {};
      if (body.title !== undefined) updates.title = String(body.title).trim() || "Untitled Campaign";
      if (body.link_url !== undefined) updates.link_url = sanitizeUrl(body.link_url);
      if (body.media_url !== undefined) {
        updates.media_url = sanitizeUrl(body.media_url);
        updates.media_type = updates.media_url.match(/\.(mp4|webm|ogg)$/i) ? "video" : "image";
      }
      if (body.placement !== undefined) updates.placement = body.placement;
      if (body.rotation_seconds !== undefined) updates.rotation_seconds = Math.max(3, parseInt(body.rotation_seconds) || 12);
      if (body.priority !== undefined) updates.priority = parseInt(body.priority) || 1;
      if (body.active !== undefined) updates.active = !!body.active;
      if (body.body !== undefined) updates.body = String(body.body).trim();
      if (body.cta_text !== undefined) updates.cta_text = String(body.cta_text).trim().slice(0, 30);
      if (body.device_target !== undefined) updates.device_target = body.device_target;

      const updated = await supabase.updateAd(adId, updates);
      await supabase.logAction("AD_UPDATE", { adId, updates }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ad: updated });
    }

    // POST /api/admin/ads/:id/reset - Reset Impression & Click Counters
    const adResetMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/reset$/);
    if (adResetMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const adId = adResetMatch[1];
      const updated = await supabase.updateAd(adId, { impressions: 0, clicks: 0 });
      if (!updated) return sendJson(404, { error: "Ad not found" });
      await supabase.logAction("AD_RESET_STATS", { adId }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, ad: updated });
    }

    // POST /api/admin/ads/:id/duplicate - Duplicate Ad Campaign
    const adDupMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/duplicate$/);
    if (adDupMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "ads:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const adId = adDupMatch[1];
      const source = await supabase.getAdById(adId);
      if (!source) return sendJson(404, { error: "Ad not found" });

      const cloned = await supabase.addAd({
        title: `${source.title} (Copy)`,
        media_url: source.media_url,
        media_type: source.media_type,
        link_url: source.link_url,
        placement: source.placement,
        rotation_seconds: source.rotation_seconds,
        priority: source.priority,
        active: false,
        created_by: admin.username
      });
      await supabase.logAction("AD_DUPLICATE", { originalId: adId, newId: cloned.id }, admin.id, getClientIp(req));
      return sendJson(201, { success: true, ad: cloned });
    }

    // DELETE /api/admin/ads/:id - Delete Ad
    const adDeleteMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)$/);
    if (adDeleteMatch && req.method === "DELETE") {
      if (!hasPermission(admin.role, "ads:delete")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to delete ads." });
      }
      const adId = adDeleteMatch[1];
      const ad = await supabase.getAdById(adId);
      // Per specification: Media files in uploads directory must be preserved and never deleted
      await supabase.deleteAd(adId);
      await supabase.logAction("AD_DELETE", { adId, title: ad.title }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: "Ad deleted" });
    }

    // ==================================================
    // MODERATION & CONNECTIONS (RBAC: clients & reports)
    // ==================================================

    // GET /api/admin/connections - List active connections
    if (requestPath === "/api/admin/connections" && req.method === "GET") {
      if (!hasPermission(admin.role, "clients:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const list = [];
      for (const client of connectedClients) {
        list.push({
          id: client.id,
          ip: client.ip || "unknown",
          isReady: !!client.ready,
          isMatched: !!client.peer,
          peerId: client.peer ? client.peer.id : null,
          connectedAt: client.connectedAt
        });
      }
      return sendJson(200, { clients: list });
    }

    // GET /api/admin/reports - List Reports
    if (requestPath === "/api/admin/reports" && req.method === "GET") {
      if (!hasPermission(admin.role, "reports:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const reports = await supabase.getReports({ limit: 100 });
      return sendJson(200, { reports });
    }

    // POST /api/admin/reports/:id/status - Update Report Status
    const reportStatusMatch = requestPath.match(/^\/api\/admin\/reports\/([^/]+)\/status$/);
    if (reportStatusMatch && req.method === "POST") {
      if (!hasPermission(admin.role, "reports:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const reportId = reportStatusMatch[1];
      const { status, notes } = await parseJsonBody(req);
      const updated = await supabase.updateReportStatus(reportId, status, notes);
      await supabase.logAction("REPORT_RESOLVE", { reportId, status }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, report: updated });
    }

    // GET /api/admin/bans - List Bans
    if (requestPath === "/api/admin/bans" && req.method === "GET") {
      if (!hasPermission(admin.role, "bans:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const bans = await supabase.getBans();
      return sendJson(200, { bans });
    }

    // POST /api/admin/ban - Ban IP
    if (requestPath === "/api/admin/ban" && req.method === "POST") {
      if (!hasPermission(admin.role, "bans:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to ban IPs." });
      }
      const { ip, reason, durationHours } = await parseJsonBody(req);
      if (!ip) return sendJson(400, { error: "Missing IP address" });

      await supabase.addBan({ ip, reason, bannedBy: admin.username, durationHours });
      await redis.addBannedIp(ip);

      // Disconnect any active sockets matching this banned IP
      for (const client of connectedClients) {
        if (client.ip === ip) {
          send(client, { type: "banned", reason: reason || "Suspended by moderator." });
          if (client.peer) {
            send(client.peer, { type: "peer-disconnected" });
            client.peer.peer = null;
            if (client.peer.ready) putInWaitingQueue(client.peer);
          }
          client.peer = null;
          client.ready = false;
          removeFromWaiting(client);
          try { client.close(); } catch (e) {}
        }
      }

      await supabase.logAction("BAN_IP", { ip, reason, bannedBy: admin.username }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `IP ${ip} banned successfully` });
    }

    // POST /api/admin/unban - Unban IP
    if (requestPath === "/api/admin/unban" && req.method === "POST") {
      if (!hasPermission(admin.role, "bans:write")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions to unban IPs." });
      }
      const { ip } = await parseJsonBody(req);
      if (!ip) return sendJson(400, { error: "Missing IP address" });

      await supabase.removeBan(ip);
      await redis.removeBannedIp(ip);
      await supabase.logAction("UNBAN_IP", { ip }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `IP ${ip} unbanned` });
    }

    // POST /api/admin/kick - Disconnect Client
    if (requestPath === "/api/admin/kick" && req.method === "POST") {
      if (!hasPermission(admin.role, "clients:kick")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const { clientId } = await parseJsonBody(req);
      let targetClient = null;
      for (const client of connectedClients) {
        if (client.id === Number(clientId)) {
          targetClient = client;
          break;
        }
      }

      if (targetClient) {
        if (targetClient.peer) {
          send(targetClient.peer, { type: "peer-disconnected" });
          targetClient.peer.peer = null;
          if (targetClient.peer.ready) putInWaitingQueue(targetClient.peer);
        }
        targetClient.peer = null;
        targetClient.ready = false;
        removeFromWaiting(targetClient);
        try { targetClient.close(); } catch (e) {}
        await supabase.logAction("KICK_CLIENT", { clientId }, admin.id, getClientIp(req));
        return sendJson(200, { success: true, message: `Client #${clientId} disconnected` });
      }
      return sendJson(404, { error: "Client not found" });
    }

    // GET /api/admin/announcements - List active announcement and history
    if (requestPath === "/api/admin/announcements" && req.method === "GET") {
      return sendJson(200, {
        active: activeAnnouncement,
        history: announcementHistory
      });
    }

    // POST /api/admin/broadcast or POST /api/admin/announcements - Publish Announcement & Optional Maintenance Lockout
    if ((requestPath === "/api/admin/broadcast" || requestPath === "/api/admin/announcements") && req.method === "POST") {
      if (!hasPermission(admin.role, "broadcast:send")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const body = await parseJsonBody(req);
      const message = (body.message || "").trim();
      if (!message) return sendJson(400, { error: "Message cannot be empty" });

      const lockout = !!body.lockout;
      const title = (body.title || "").trim() || (lockout ? "Website Maintenance & Update" : "System Announcement");

      activeAnnouncement = {
        id: "ann_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
        title,
        message: message.slice(0, 500),
        lockout,
        created_by: admin.username,
        created_at: new Date().toISOString()
      };

      announcementHistory.unshift(activeAnnouncement);
      if (announcementHistory.length > 50) announcementHistory.pop();

      // If lockout mode is turned on, cleanly terminate active peer calls and clear waiting queue
      if (lockout) {
        for (const client of connectedClients) {
          removeFromWaiting(client);
          if (client.peer) {
            send(client.peer, { type: "peer-disconnected" });
            client.peer.peer = null;
            client.peer.ready = false;
            client.peer = null;
          }
          client.ready = false;
        }
      }

      // Real-time broadcast to all connected WebSocket clients
      for (const client of connectedClients) {
        send(client, {
          type: "system_announcement",
          announcement: activeAnnouncement
        });
      }

      await supabase.logAction(
        lockout ? "MAINTENANCE_LOCK_ACTIVE" : "BROADCAST",
        { id: activeAnnouncement.id, title, message: activeAnnouncement.message, lockout },
        admin.id,
        getClientIp(req)
      );

      return sendJson(200, {
        success: true,
        announcement: activeAnnouncement,
        sentTo: connectedClients.size
      });
    }

    // DELETE /api/admin/announcements/:id or DELETE /api/admin/broadcast - Delete Announcement & Resume Website Access
    const annDeleteMatch = requestPath.match(/^\/api\/admin\/announcements\/([^/]+)$/);
    if ((annDeleteMatch || requestPath === "/api/admin/broadcast") && req.method === "DELETE") {
      if (!hasPermission(admin.role, "broadcast:send")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const targetId = annDeleteMatch ? annDeleteMatch[1] : (activeAnnouncement ? activeAnnouncement.id : null);
      if (!activeAnnouncement || (targetId !== "active" && targetId !== "current" && activeAnnouncement.id !== targetId)) {
        return sendJson(404, { error: "No active announcement matching that ID" });
      }

      const cleared = activeAnnouncement;
      activeAnnouncement = null;

      // Broadcast clearance to all clients to immediately unlock user interaction
      for (const client of connectedClients) {
        send(client, {
          type: "announcement_cleared",
          id: cleared.id
        });
      }

      await supabase.logAction(
        "MAINTENANCE_LOCK_CLEARED",
        { id: cleared.id, title: cleared.title },
        admin.id,
        getClientIp(req)
      );

      return sendJson(200, {
        success: true,
        message: "Announcement deleted and website unlocked for users."
      });
    }

    // ==================================================
    // ADMIN USER & ROLE MANAGEMENT (superadmin ONLY)
    // ==================================================

    // GET /api/admin/users - List Administrators
    if (requestPath === "/api/admin/users" && req.method === "GET") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to manage accounts." });
      }
      const admins = await supabase.getAdmins();
      return sendJson(200, { admins });
    }

    // POST /api/admin/users - Create New Administrator
    if (requestPath === "/api/admin/users" && req.method === "POST") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to create accounts." });
      }
      const { username, email, role, password } = await parseJsonBody(req);
      if (!username || !password) {
        return sendJson(400, { error: "Username and password required" });
      }
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(password, salt);

      const created = await supabase.createAdminAccount({
        username: username.trim(),
        email: (email || "").trim(),
        role: role || "moderator",
        password_hash: hash
      });

      await supabase.logAction("ADMIN_CREATED", { username: created.username, role: created.role }, admin.id, getClientIp(req));
      return sendJson(201, { success: true, admin: created });
    }

    // PUT /api/admin/users/:id/role - Update Admin Role
    const userRoleMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
    if (userRoleMatch && req.method === "PUT") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to edit roles." });
      }
      const targetId = userRoleMatch[1];
      const { role } = await parseJsonBody(req);
      if (!ROLE_PERMISSIONS[role]) {
        return sendJson(400, { error: "Invalid role specified" });
      }

      const updated = await supabase.updateAdminRole(targetId, role);
      await supabase.logAction("ROLE_UPDATED", { targetId, newRole: role }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, admin: updated });
    }

    // POST /api/admin/change-password - Change own password
    if (requestPath === "/api/admin/change-password" && req.method === "POST") {
      const { currentPassword, newPassword } = await parseJsonBody(req);
      if (!currentPassword || !newPassword) {
        return sendJson(400, { error: "Current password and new password are required" });
      }
      if (newPassword.length < 6) {
        return sendJson(400, { error: "New password must be at least 6 characters" });
      }

      // Fetch user from DB/store
      const user = await supabase.getAdminByUsername(admin.username);
      let isMatch = false;
      if (user && user.password_hash) {
        isMatch = bcrypt.compareSync(currentPassword, user.password_hash);
      } else if (admin.username === ADMIN_USERNAME && currentPassword === ADMIN_PASSWORD) {
        isMatch = true;
      }

      if (!isMatch) {
        return sendJson(401, { error: "Current password is incorrect" });
      }

      const salt = bcrypt.genSaltSync(10);
      const newHash = bcrypt.hashSync(newPassword, salt);
      const updatedUser = await supabase.updateAdminPassword(admin.id, newHash);
      await supabase.logAction("PASSWORD_CHANGED", { username: admin.username, role: admin.role }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: "Password updated successfully" });
    }

    // DELETE /api/admin/users/:id - Superadmin delete account with safety measures
    const userDeleteMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userDeleteMatch && req.method === "DELETE") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to delete accounts." });
      }
      const targetId = userDeleteMatch[1];
      const targetUser = await supabase.getAdminById(targetId);
      if (!targetUser) {
        return sendJson(404, { error: "Account not found" });
      }

      // Safety check 1: Cannot delete own account
      if (targetUser.id === admin.id || targetUser.username.toLowerCase() === admin.username.toLowerCase()) {
        return sendJson(400, { error: "Safety violation: You cannot delete your own logged-in account." });
      }

      // Safety check 2: Cannot delete root admin
      if (targetUser.username.toLowerCase() === "admin" || targetUser.id === "admin-super-1") {
        return sendJson(400, { error: "Safety violation: The root system administrator account cannot be deleted." });
      }

      // Safety check 3: Ensure there is at least one active superadmin remaining
      if (targetUser.role === "superadmin") {
        const allAdmins = await supabase.getAdmins();
        const superadmins = allAdmins.filter(a => a.role === "superadmin" && a.id !== targetId);
        if (superadmins.length === 0) {
          return sendJson(400, { error: "Safety violation: Cannot delete the last remaining superadmin account." });
        }
      }

      await supabase.deleteAdminAccount(targetId);
      await supabase.logAction("ADMIN_DELETED", { targetId, username: targetUser.username, role: targetUser.role }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `Account for ${targetUser.username} deleted successfully` });
    }

    // PUT /api/admin/users/:id/password - Superadmin reset staff password
    const userPassMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (userPassMatch && req.method === "PUT") {
      if (admin.role !== "superadmin") {
        return sendJson(403, { error: "Superadmin role required to reset passwords." });
      }
      const targetId = userPassMatch[1];
      const { newPassword } = await parseJsonBody(req);
      if (!newPassword || newPassword.length < 6) {
        return sendJson(400, { error: "Password must be at least 6 characters" });
      }
      const targetUser = await supabase.getAdminById(targetId);
      if (!targetUser) {
        return sendJson(404, { error: "Account not found" });
      }
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(newPassword, salt);
      await supabase.updateAdminPassword(targetId, hash);
      await supabase.logAction("ADMIN_PASSWORD_RESET", { targetId, username: targetUser.username }, admin.id, getClientIp(req));
      return sendJson(200, { success: true, message: `Password reset for ${targetUser.username}` });
    }

    // GET /api/admin/logs - System Audit Logs
    if (requestPath === "/api/admin/logs" && req.method === "GET") {
      if (!hasPermission(admin.role, "logs:read")) {
        return sendJson(403, { error: "Forbidden. Insufficient permissions." });
      }
      const logs = await supabase.getLogs(100);
      return sendJson(200, { logs });
    }

    return sendJson(404, { error: "Admin endpoint not found" });
  }

  // --------------------------------------------------
  // PUBLIC ADS & ENGAGEMENT API (FOR USER index.html)
  // --------------------------------------------------

  // GET /api/announcement - Get active announcement / maintenance status
  if (requestPath === "/api/announcement" && req.method === "GET") {
    return sendJson(200, { announcement: activeAnnouncement });
  }

  // GET /api/ads - Get active ads for user dashboard with settings
  if (requestPath === "/api/ads" && req.method === "GET") {
    const settings = await supabase.getAdSettings();
    if (settings && settings.enabled === false) {
      return sendJson(200, { ads: [], settings });
    }
    const activeAds = await supabase.getActiveAds();
    // Return sanitized ads list for the frontend
    const sanitized = activeAds.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body || "",
      cta_text: a.cta_text || "Learn more ↗",
      media_url: a.media_url,
      media_type: a.media_type,
      link_url: a.link_url,
      placement: a.placement || settings.defaultPlacement || "stranger-overlay",
      device_target: a.device_target || "all",
      rotation_seconds: a.rotation_seconds || settings.rotationSeconds || 12,
      priority: a.priority || 1
    }));
    return sendJson(200, { ads: sanitized, settings });
  }

  // POST /api/ads/:id/impression - Record ad impression
  const adImpressionMatch = requestPath.match(/^\/api\/ads\/([^/]+)\/impression$/);
  if (adImpressionMatch && req.method === "POST") {
    const adId = adImpressionMatch[1];
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    supabase.recordAdImpression(adId, ip, ua);
    redis.incrementMetric("adImpressions");
    return sendJson(200, { success: true });
  }

  // POST /api/ads/:id/click - Record ad click
  const adClickMatch = requestPath.match(/^\/api\/ads\/([^/]+)\/click$/);
  if (adClickMatch && req.method === "POST") {
    const adId = adClickMatch[1];
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    supabase.recordAdClick(adId, ip, ua);
    redis.incrementMetric("adClicks");
    return sendJson(200, { success: true });
  }

  // --------------------------------------------------
  // STATIC FILE SERVING WITH SECURITY HARDENING
  // --------------------------------------------------

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  try {
    requestPath = decodeURIComponent(requestPath);
  } catch (error) {
    res.writeHead(400);
    return res.end("Bad request");
  }

  // Serve uploaded ad creatives with safe path verification
  if (requestPath.startsWith("/uploads/")) {
    const safeBaseName = path.basename(requestPath);
    const uploadFilePath = path.join(uploadsDir, safeBaseName);

    // Verify file stays within uploadsDir
    if (!uploadFilePath.startsWith(uploadsDir + path.sep) && uploadFilePath !== uploadsDir) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    fs.readFile(uploadFilePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(uploadFilePath).toLowerCase();
      const contentTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".avif": "image/avif",
        ".mp4": "video/mp4",
        ".webm": "video/webm"
      };
      res.writeHead(200, {
        "Content-Type": contentTypes[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=86400"
      });
      res.end(data);
    });
    return;
  }

  // Standard static file serving from publicDir
  const filePath = path.resolve(publicDir, "." + requestPath);

  // Prevent directory traversal outside the public folder
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      // Fallback: if requesting index.html or not found, try serving public/index.html
      if (requestPath === "/index.html") {
        res.writeHead(404);
        return res.end("Application entry point missing");
      }
      res.writeHead(404);
      return res.end("Not found");
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".json": "application/json",
      ".webp": "image/webp"
    };

    const contentType = contentTypes[extension] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
});

// ==================================================
// WEBSOCKET SIGNALING SERVER (WEBRTC)
// ==================================================

const wss = new WebSocket.Server({
  server,
  maxPayload: 64 * 1024 // 64KB max payload (DoS protection)
});

let nextClientId = 1;
const waitingClients = [];
const connectedClients = new Set();

function broadcastOnlineCount() {
  const uniqueIps = new Set();
  for (const client of connectedClients) {
    if (client.ip) uniqueIps.add(client.ip);
    else uniqueIps.add(client.id);
  }

  const message = {
    type: "online-count",
    count: uniqueIps.size
  };

  for (const client of connectedClients) {
    send(client, message);
  }
}

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
    } catch (e) {}
  }
}

function removeFromWaiting(socket) {
  const index = waitingClients.indexOf(socket);
  if (index !== -1) {
    waitingClients.splice(index, 1);
  }
}

function putInWaitingQueue(socket) {
  if (!socket || socket.readyState !== WebSocket.OPEN || socket.peer) {
    return;
  }

  if (!waitingClients.includes(socket)) {
    waitingClients.push(socket);
  }

  send(socket, { type: "waiting" });
}

function tryMatchUsers() {
  for (let i = waitingClients.length - 1; i >= 0; i--) {
    if (waitingClients[i].readyState !== WebSocket.OPEN) {
      waitingClients.splice(i, 1);
    }
  }

  while (waitingClients.length >= 2) {
    const clientA = waitingClients.shift();
    const clientB = waitingClients.shift();

    if (clientA.readyState !== WebSocket.OPEN || clientB.readyState !== WebSocket.OPEN) {
      continue;
    }

    clientA.peer = clientB;
    clientB.peer = clientA;

    redis.incrementMetric("matchesCompleted");

    send(clientA, { type: "matched", role: "caller" });
    send(clientB, { type: "matched", role: "callee" });

    send(clientA, { type: "create-offer" });
  }
}

wss.on("connection", async (socket, request) => {
  const clientIp = getClientIp(request);

  // Rapid Banned IP verification check
  const banned = (await redis.isIpBannedFast(clientIp)) || (await supabase.isIpBanned(clientIp));
  if (banned) {
    send(socket, { type: "banned", reason: "Access suspended due to community guidelines violation." });
    setTimeout(() => {
      try { socket.close(); } catch (e) {}
    }, 200);
    return;
  }

  socket.id = nextClientId++;
  socket.ip = clientIp;
  socket.connectedAt = Date.now();
  socket.ready = false;
  socket.peer = null;

  connectedClients.add(socket);
  redis.trackClient(socket.id, socket.ip);
  broadcastOnlineCount();

  // If active announcement exists (lockout or banner notice), immediately send to this connection
  if (activeAnnouncement) {
    send(socket, {
      type: "system_announcement",
      announcement: activeAnnouncement
    });
  }

  socket.on("message", async (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
    } catch (error) {
      return;
    }

    // If website is locked for maintenance, block interaction requests
    if (activeAnnouncement && activeAnnouncement.lockout) {
      if (["ready", "signal", "offer", "answer", "candidate", "skip", "chat"].includes(message.type)) {
        send(socket, {
          type: "system_announcement",
          announcement: activeAnnouncement
        });
        return;
      }
    }

    if (message.type === "ready") {
      if (socket.ready) return;
      socket.ready = true;
      putInWaitingQueue(socket);
      tryMatchUsers();
      return;
    }

    if (message.type === "stop") {
      removeFromWaiting(socket);
      const oldPeer = socket.peer;
      socket.ready = false;
      socket.peer = null;

      if (oldPeer && oldPeer.readyState === WebSocket.OPEN) {
        oldPeer.peer = null;
        send(oldPeer, { type: "peer-disconnected" });
      }
      return;
    }

    if (message.type === "skip") {
      const oldPeer = socket.peer;
      socket.peer = null;

      if (oldPeer) {
        oldPeer.peer = null;
        send(oldPeer, { type: "peer-disconnected" });
        if (oldPeer.ready) {
          putInWaitingQueue(oldPeer);
        }
      }

      removeFromWaiting(socket);

      if (socket.readyState === WebSocket.OPEN && socket.ready) {
        waitingClients.unshift(socket);
        send(socket, { type: "waiting" });
      }

      tryMatchUsers();
      return;
    }

    if (message.type === "report") {
      const reportedPeer = socket.peer;
      const reportData = {
        reporterId: socket.id,
        reportedId: reportedPeer ? reportedPeer.id : null,
        reporterIp: socket.ip,
        reportedIp: reportedPeer ? reportedPeer.ip : "unknown",
        reason: (typeof message.reason === "string" ? message.reason.slice(0, 100) : "Unspecified")
      };

      await supabase.saveReport(reportData);
      redis.publishEvent("reports:new", reportData);
      redis.incrementMetric("reportsReceived");

      send(socket, { type: "report-received" });
      return;
    }

    if (
      message.type === "record-request" ||
      message.type === "record-response" ||
      message.type === "recording-started" ||
      message.type === "recording-paused" ||
      message.type === "recording-stopped" ||
      message.type === "offer" ||
      message.type === "answer" ||
      message.type === "ice-candidate"
    ) {
      if (socket.peer && socket.peer.readyState === WebSocket.OPEN) {
        send(socket.peer, message);
      }
      return;
    }
  });

  socket.on("error", () => {});

  socket.on("close", () => {
    connectedClients.delete(socket);
    redis.removeClient(socket.id);
    broadcastOnlineCount();

    removeFromWaiting(socket);
    const oldPeer = socket.peer;
    socket.peer = null;

    if (oldPeer) {
      oldPeer.peer = null;
      send(oldPeer, { type: "peer-disconnected" });
      if (oldPeer.ready) {
        putInWaitingQueue(oldPeer);
        tryMatchUsers();
      }
    }
  });
});

// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("==================================================");
  console.log(" LELA WebRTC & Admin Control Center Online");
  console.log("==================================================");
  console.log(`Port: ${PORT} | Host: ${HOST}`);
  console.log(`User Dashboard:  http://localhost:${PORT}/`);
  console.log(`Admin Panel:     http://localhost:${PORT}/admin`);
  console.log(`Default Super:   ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
  console.log("==================================================");
  console.log("");
});
