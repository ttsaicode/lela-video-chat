const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
let isConfigured = false;

// In-memory fallback store when Supabase is not configured
const inMemoryStore = {
  reports: [],
  bans: new Map(), // ip -> ban object
  admins: [
    {
      id: "admin-default",
      email: process.env.ADMIN_USERNAME || "admin",
      role: "admin",
      created_at: new Date().toISOString()
    }
  ],
  logs: []
};

if (supabaseUrl && supabaseKey && !supabaseUrl.includes("your-project")) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });
    isConfigured = true;
    console.log("[SUPABASE] Connected to Supabase project:", supabaseUrl);
  } catch (error) {
    console.error("[SUPABASE] Initialization error:", error.message);
  }
} else {
  console.log("[SUPABASE] Supabase credentials not provided. Using in-memory store for reports and bans.");
}

function isSupabaseConfigured() {
  return isConfigured;
}

// --------------------------------------------------
// REPORTS
// --------------------------------------------------

async function saveReport({ reporterId, reportedId, reporterIp, reportedIp, reason }) {
  const newReport = {
    id: "rep_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    reporter_id: reporterId || null,
    reported_id: reportedId || null,
    reporter_ip: reporterIp || "unknown",
    reported_ip: reportedIp || "unknown",
    reason: reason || "Unspecified",
    status: "pending",
    action_notes: null,
    created_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("reports")
        .insert([
          {
            reporter_id: reporterId,
            reported_id: reportedId,
            reporter_ip: reporterIp,
            reported_ip: reportedIp,
            reason: reason,
            status: "pending"
          }
        ])
        .select()
        .single();

      if (!error && data) {
        return data;
      }
      console.warn("[SUPABASE] Insert report error, falling back to local:", error?.message);
    } catch (err) {
      console.warn("[SUPABASE] Error saving report:", err.message);
    }
  }

  inMemoryStore.reports.unshift(newReport);
  if (inMemoryStore.reports.length > 500) {
    inMemoryStore.reports.pop();
  }
  return newReport;
}

async function getReports({ status, limit = 50 } = {}) {
  if (isConfigured && supabase) {
    try {
      let query = supabase
        .from("reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (status && status !== "all") {
        query = query.eq("status", status);
      }

      const { data, error } = await query;
      if (!error && data) {
        return data;
      }
    } catch (err) {
      console.warn("[SUPABASE] Error fetching reports:", err.message);
    }
  }

  let list = inMemoryStore.reports;
  if (status && status !== "all") {
    list = list.filter((r) => r.status === status);
  }
  return list.slice(0, limit);
}

async function updateReportStatus(reportId, status, actionNotes = "") {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("reports")
        .update({
          status,
          action_notes: actionNotes,
          resolved_at: new Date().toISOString()
        })
        .eq("id", reportId)
        .select()
        .single();

      if (!error && data) {
        return data;
      }
    } catch (err) {
      console.warn("[SUPABASE] Error updating report:", err.message);
    }
  }

  const report = inMemoryStore.reports.find((r) => r.id === reportId);
  if (report) {
    report.status = status;
    report.action_notes = actionNotes;
    report.resolved_at = new Date().toISOString();
    return report;
  }
  return null;
}

// --------------------------------------------------
// BANS
// --------------------------------------------------

async function addBan({ ip, reason, bannedBy = "admin", durationHours = null }) {
  const expiresAt = durationHours
    ? new Date(Date.now() + durationHours * 3600 * 1000).toISOString()
    : null;

  const banRecord = {
    id: "ban_" + Date.now(),
    ip,
    reason: reason || "Violation of terms",
    banned_by: bannedBy,
    banned_at: new Date().toISOString(),
    expires_at: expiresAt
  };

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bans")
        .upsert(
          {
            ip,
            reason: banRecord.reason,
            banned_by: bannedBy,
            banned_at: banRecord.banned_at,
            expires_at: expiresAt
          },
          { onConflict: "ip" }
        )
        .select()
        .single();

      if (!error && data) {
        return data;
      }
    } catch (err) {
      console.warn("[SUPABASE] Error adding ban:", err.message);
    }
  }

  inMemoryStore.bans.set(ip, banRecord);
  return banRecord;
}

async function removeBan(ip) {
  if (isConfigured && supabase) {
    try {
      const { error } = await supabase.from("bans").delete().eq("ip", ip);
      if (!error) return true;
    } catch (err) {
      console.warn("[SUPABASE] Error removing ban:", err.message);
    }
  }

  return inMemoryStore.bans.delete(ip);
}

async function getBans() {
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bans")
        .select("*")
        .order("banned_at", { ascending: false });

      if (!error && data) {
        return data;
      }
    } catch (err) {
      console.warn("[SUPABASE] Error getting bans:", err.message);
    }
  }

  return Array.from(inMemoryStore.bans.values());
}

async function isIpBanned(ip) {
  if (!ip) return false;

  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from("bans")
        .select("id, expires_at")
        .eq("ip", ip)
        .maybeSingle();

      if (!error && data) {
        if (data.expires_at && new Date(data.expires_at) < new Date()) {
          // Expired ban, delete it
          await removeBan(ip);
          return false;
        }
        return true;
      }
    } catch (err) {
      console.warn("[SUPABASE] Error checking ban:", err.message);
    }
  }

  const localBan = inMemoryStore.bans.get(ip);
  if (localBan) {
    if (localBan.expires_at && new Date(localBan.expires_at) < new Date()) {
      inMemoryStore.bans.delete(ip);
      return false;
    }
    return true;
  }
  return false;
}

// --------------------------------------------------
// LOGS
// --------------------------------------------------

async function logAction(action, details = {}) {
  const logItem = {
    id: "log_" + Date.now(),
    action,
    details,
    created_at: new Date().toISOString()
  };

  if (isConfigured && supabase) {
    try {
      await supabase.from("system_logs").insert([{ action, details }]);
      return;
    } catch (err) {
      // ignore
    }
  }

  inMemoryStore.logs.unshift(logItem);
  if (inMemoryStore.logs.length > 200) {
    inMemoryStore.logs.pop();
  }
}

module.exports = {
  isSupabaseConfigured,
  saveReport,
  getReports,
  updateReportStatus,
  addBan,
  removeBan,
  getBans,
  isIpBanned,
  logAction
};
