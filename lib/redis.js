const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL;

let redisClient = null;
let redisSubscriber = null;
let isConfigured = false;

// In-memory fallback
const inMemoryCache = {
  bannedIps: new Set(),
  activeClients: new Map() // clientId -> { ip, connectedAt }
};

if (redisUrl && !redisUrl.includes("example")) {
  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      retryStrategy(times) {
        if (times > 3) {
          console.warn("[REDIS] Could not connect to Redis server after 3 attempts. Switching to in-memory mode.");
          return null; // Stop retrying
        }
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true
    });

    redisClient
      .connect()
      .then(() => {
        isConfigured = true;
        console.log("[REDIS] Connected to Redis server:", redisUrl.replace(/\/\/[^@]*@/, "//***@"));
      })
      .catch((err) => {
        console.warn("[REDIS] Connection failed:", err.message, "- Falling back to in-memory store.");
      });

    redisClient.on("error", (err) => {
      // Don't crash on connection error
    });
  } catch (error) {
    console.warn("[REDIS] Initialization failed:", error.message);
  }
} else {
  console.log("[REDIS] REDIS_URL not configured. Running with in-memory state.");
}

function isRedisConfigured() {
  return isConfigured && redisClient && redisClient.status === "ready";
}

async function addBannedIp(ip) {
  inMemoryCache.bannedIps.add(ip);
  if (isRedisConfigured()) {
    try {
      await redisClient.sadd("bans:ip", ip);
    } catch (e) {
      console.warn("[REDIS] sadd error:", e.message);
    }
  }
}

async function removeBannedIp(ip) {
  inMemoryCache.bannedIps.delete(ip);
  if (isRedisConfigured()) {
    try {
      await redisClient.srem("bans:ip", ip);
    } catch (e) {
      console.warn("[REDIS] srem error:", e.message);
    }
  }
}

async function isIpBannedFast(ip) {
  if (!ip) return false;
  if (inMemoryCache.bannedIps.has(ip)) return true;

  if (isRedisConfigured()) {
    try {
      const isMember = await redisClient.sismember("bans:ip", ip);
      if (isMember) {
        inMemoryCache.bannedIps.add(ip);
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function trackClient(clientId, ip) {
  const info = { id: clientId, ip, connectedAt: Date.now() };
  inMemoryCache.activeClients.set(clientId, info);

  if (isRedisConfigured()) {
    try {
      await redisClient.hset("clients:active", clientId, JSON.stringify(info));
    } catch (e) {}
  }
}

async function removeClient(clientId) {
  inMemoryCache.activeClients.delete(clientId);

  if (isRedisConfigured()) {
    try {
      await redisClient.hdel("clients:active", clientId);
    } catch (e) {}
  }
}

async function getActiveClients() {
  if (isRedisConfigured()) {
    try {
      const hash = await redisClient.hgetall("clients:active");
      const list = Object.values(hash).map((val) => {
        try {
          return JSON.parse(val);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return list;
    } catch (e) {}
  }
  return Array.from(inMemoryCache.activeClients.values());
}

async function publishEvent(channel, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  if (isRedisConfigured()) {
    try {
      await redisClient.publish(channel, payload);
    } catch (e) {}
  }
}

module.exports = {
  isRedisConfigured,
  addBannedIp,
  removeBannedIp,
  isIpBannedFast,
  trackClient,
  removeClient,
  getActiveClients,
  publishEvent
};
