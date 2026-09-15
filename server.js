require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const formidable = require("formidable"); // NEW: For handling file uploads

const supabase = require("./lib/supabase");
const redis = require("./lib/redis");

// Railway provides PORT in production. Local development falls back to 3000.
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const publicDir = path.join(__dirname, "public");
const adminDir = path.join(__dirname, "admin");
const uploadsDir = path.join(__dirname, "uploads"); // NEW: Ad uploads directory

// Ensure the uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Admin auth credentials & active sessions
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const adminTokens = new Set();

// In-memory storage for ads (Replace with Supabase for persistence across restarts)
let ads = [];

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket ? req.socket.remoteAddress : "unknown";
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error("Request body too large"));
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

function verifyAdminToken(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return adminTokens.has(token);
}

// ==================================================
// HTTP SERVER & ADMIN API
// ==================================================

const server = http.createServer(async (req, res) => {
  let requestPath = req.url.split("?")[0];

  // Helper for JSON responses
  const sendJson = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // --------------------------------------------------
  // ADMIN ROUTES
  // --------------------------------------------------

  // Admin Dashboard page
  if (requestPath === "/admin" || requestPath === "/admin/") {
    const adminHtmlPath = path.join(adminDir, "index.html");
    fs.readFile(adminHtmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error loading admin dashboard");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // Admin Login
  if (requestPath === "/api/admin/login" && req.method === "POST") {
    try {
      const { username, password } = await parseJsonBody(req);
      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = "adm_" + crypto.randomBytes(24).toString("hex");
        adminTokens.add(token);
        supabase.logAction("ADMIN_LOGIN", { username, ip: getClientIp(req) });
        return sendJson(200, { success: true, token });
      }
      return sendJson(401, { error: "Invalid credentials" });
    } catch (e) {
      return sendJson(400, { error: e.message });
    }
  }

  // Admin API Auth Guard
  if (requestPath.startsWith("/api/admin/")) {
    if (!verifyAdminToken(req)) {
      return sendJson(401, { error: "Unauthorized. Admin authentication required." });
    }

    // GET /api/admin/stats
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

      return sendJson(200, {
        onlineCount: uniqueIps.size,
        totalConnections: connectedClients.size,
        waitingCount: waitingClients.length,
        activePairsCount: activePairs,
        totalReports: allReports.length,
        totalBans: allBans.length,
        totalAds: ads.filter(a => a.active).length, // NEW: Live ads count
        redisConnected: redis.isRedisConfigured(),
        supabaseConnected: supabase.isSupabaseConfigured()
      });
    }

    // GET /api/admin/connections
    if (requestPath === "/api/admin/connections" && req.method === "GET") {
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

    // GET /api/admin/reports
    if (requestPath === "/api/admin/reports" && req.method === "GET") {
      const reports = await supabase.getReports({ limit: 100 });
      return sendJson(200, { reports });
    }

    // POST /api/admin/reports/:id/status
    const statusMatch = requestPath.match(/^\/api\/admin\/reports\/([^/]+)\/status$/);
    if (statusMatch && req.method === "POST") {
      const reportId = statusMatch[1];
      const { status, notes } = await parseJsonBody(req);
      const updated = await supabase.updateReportStatus(reportId, status, notes);
      return sendJson(200, { success: true, report: updated });
    }

    // GET /api/admin/bans
    if (requestPath === "/api/admin/bans" && req.method === "GET") {
      const bans = await supabase.getBans();
      return sendJson(200, { bans });
    }

    // POST /api/admin/ban
    if (requestPath === "/api/admin/ban" && req.method === "POST") {
      const { ip, reason, durationHours } = await parseJsonBody(req);
      if (!ip) return sendJson(400, { error: "Missing IP address" });

      await supabase.addBan({ ip, reason, bannedBy: "admin", durationHours });
      await redis.addBannedIp(ip);

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

      supabase.logAction("BAN_IP", { ip, reason });
      return sendJson(200, { success: true, message: `IP ${ip} banned successfully` });
    }

    // POST /api/admin/unban
    if (requestPath === "/api/admin/unban" && req.method === "POST") {
      const { ip } = await parseJsonBody(req);
      if (!ip) return sendJson(400, { error: "Missing IP address" });

      await supabase.removeBan(ip);
      await redis.removeBannedIp(ip);
      supabase.logAction("UNBAN_IP", { ip });
      return sendJson(200, { success: true, message: `IP ${ip} unbanned` });
    }

    // POST /api/admin/kick
    if (requestPath === "/api/admin/kick" && req.method === "POST") {
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
        return sendJson(200, { success: true, message: `Client #${clientId} disconnected` });
      }
      return sendJson(404, { error: "Client not found" });
    }

    // POST /api/admin/broadcast
    if (requestPath === "/api/admin/broadcast" && req.method === "POST") {
      const { message } = await parseJsonBody(req);
      if (!message) return sendJson(400, { error: "Message cannot be empty" });

      for (const client of connectedClients) {
        send(client, { type: "broadcast", text: message });
      }
      supabase.logAction("BROADCAST", { message });
      return sendJson(200, { success: true, sentTo: connectedClients.size });
    }

    // ================== ADS MANAGEMENT ==================

    // GET /api/admin/ads - List all ads
    if (requestPath === "/api/admin/ads" && req.method === "GET") {
      return sendJson(200, { ads });
    }

    // POST /api/admin/ads - Create a new ad (Handles FormData)
    if (requestPath === "/api/admin/ads" && req.method === "POST") {
      const form = new formidable.IncomingForm({
        uploadDir: uploadsDir,
        keepExtensions: true,
        maxFileSize: 25 * 1024 * 1024 // 25MB limit
      });

      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error("Form parse error:", err);
          return sendJson(500, { error: "File upload failed or too large" });
        }

        // Formidable v3 returns arrays for fields, so we grab the first item
        const getField = (val) => Array.isArray(val) ? val[0] : val;
        
        const title = getField(fields.title) || "Untitled";
        const link_url = getField(fields.link_url) || "";
        const placement = getField(fields.placement) || "corner";
        const rotation_seconds = parseInt(getField(fields.rotation_seconds)) || 12;
        const active = getField(fields.active) === "true";
        
        let mediaUrl = getField(fields.media_url) || "";
        let mediaType = "image";

        // If a file was uploaded, generate its public URL
        if (files.media && files.media.length > 0) {
          const file = files.media[0];
          mediaUrl = `/uploads/${path.basename(file.filepath)}`;
          mediaType = file.mimetype.startsWith("video/") ? "video" : "image";
        } else if (mediaUrl) {
          mediaType = mediaUrl.match(/\.(mp4|webm|ogg)$/i) ? "video" : "image";
        }

        if (!mediaUrl) {
          return sendJson(400, { error: "Media file or URL is required" });
        }

        const newAd = {
          id: Date.now().toString(),
          title,
          link_url,
          placement,
          rotation_seconds,
          active,
          media_url: mediaUrl,
          media_type: mediaType,
          created_at: new Date().toISOString()
        };

        ads.push(newAd);
        supabase.logAction("AD_CREATED", { title, mediaUrl });
        return sendJson(200, { success: true, ad: newAd });
      });
      return; // Important: return here because form.parse is async
    }

    // PUT /api/admin/ads/:id/status - Toggle Ad Status
    const adStatusMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)\/status$/);
    if (adStatusMatch && req.method === "PUT") {
      const adId = adStatusMatch[1];
      const { active } = await parseJsonBody(req);
      const ad = ads.find(a => a.id === adId);
      if (!ad) return sendJson(404, { error: "Ad not found" });
      ad.active = active;
      return sendJson(200, { success: true, ad });
    }

    // DELETE /api/admin/ads/:id - Delete an Ad
    const adDeleteMatch = requestPath.match(/^\/api\/admin\/ads\/([^/]+)$/);
    if (adDeleteMatch && req.method === "DELETE") {
      const adId = adDeleteMatch[1];
      const index = ads.findIndex(a => a.id === adId);
      if (index === -1) return sendJson(404, { error: "Ad not found" });
      
      const ad = ads[index];
      if (ad.media_url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, ad.media_url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      
      ads.splice(index, 1);
      return sendJson(200, { success: true });
    }

    return sendJson(404, { error: "API endpoint not found" });
  }

  // --------------------------------------------------
  // PUBLIC ROUTES
  // --------------------------------------------------

  // PUBLIC: Get Active Ad for Video Chat Frontend
  if (requestPath === "/api/ads" && req.method === "GET") {
    const activeAd = ads.find(a => a.active);
    return sendJson(200, { ad: activeAd || null });
  }

  // --------------------------------------------------
  // PUBLIC STATIC FILE SERVING
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

  // Serve uploaded ad files
  if (requestPath.startsWith("/uploads/")) {
    const uploadPath = path.join(__dirname, requestPath);
    fs.readFile(uploadPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(uploadPath).toLowerCase();
      const types = { 
        ".png": "image/png", 
        ".jpg": "image/jpeg", 
        ".jpeg": "image/jpeg", 
        ".gif": "image/gif", 
        ".webp": "image/webp", 
        ".mp4": "video/mp4", 
        ".webm": "video/webm" 
      };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  const filePath = path.resolve(publicDir, "." + requestPath);

  // Prevent directory traversal outside the public folder
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
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
      ".json": "application/json"
    };

    const contentType = contentTypes[extension] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});


// ==================================================
// WEBSOCKET SIGNALING SERVER
// ==================================================

const wss = new WebSocket.Server({ server });

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
    socket.send(JSON.stringify(message));
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
    console.log(`[SERVER] Client ${socket.id} is waiting.`);
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

    console.log("");
    console.log("========================================");
    console.log(`[MATCH] Client ${clientA.id} matched with Client ${clientB.id}`);
    console.log("========================================");
    console.log("");

    send(clientA, { type: "matched", role: "caller" });
    send(clientB, { type: "matched", role: "callee" });

    send(clientA, { type: "create-offer" });
  }
}

wss.on("connection", async (socket, request) => {
  const clientIp = getClientIp(request);

  const banned = (await redis.isIpBannedFast(clientIp)) || (await supabase.isIpBanned(clientIp));
  if (banned) {
    console.log(`[SERVER] Rejected connection from banned IP: ${clientIp}`);
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

  console.log(`[SERVER] Client ${socket.id} connected (IP: ${socket.ip})`);

  socket.on("message", async (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      console.error(`[SERVER] Client ${socket.id} sent invalid JSON`);
      return;
    }

    console.log(`[SERVER] Client ${socket.id} -> ${message.type}`);

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
        reason: message.reason || "Unspecified"
      };

      console.log(`[REPORT] Client ${socket.id} reported ${reportData.reportedId}: ${reportData.reason}`);
      await supabase.saveReport(reportData);
      redis.publishEvent("reports:new", reportData);

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

  socket.on("error", (error) => {
    console.error(`[SERVER] WebSocket error for Client ${socket.id}:`, error.message);
  });

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

    console.log(`[SERVER] Client ${socket.id} disconnected`);
  });
});

// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("========================================");
  console.log(" LELA WebRTC Server Running");
  console.log("========================================");
  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);
  console.log(`Video Chat: http://localhost:${PORT}/`);
  console.log(`Admin Dashboard: http://localhost:${PORT}/admin`);
  console.log(`Default Admin: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
  console.log("========================================");
  console.log("");
});