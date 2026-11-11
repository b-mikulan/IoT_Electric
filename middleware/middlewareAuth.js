const {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");
const deriveKey = promisify(scrypt);

const HASH_SCHEME = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;

function createPasswordHash(password, salt = randomBytes(SALT_BYTES).toString("hex")) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string.");
  }

  if (!/^[a-f0-9]+$/i.test(salt) || salt.length < SALT_BYTES * 2) {
    throw new Error("Password salt must be a valid hexadecimal value.");
  }

  const derivedKey = scryptSync(password, salt, KEY_BYTES);
  return `${HASH_SCHEME}:${salt}:${derivedKey.toString("hex")}`;
}

function validHash(encodedHash) {
  return typeof encodedHash === "string" && /^scrypt:[a-f0-9]{32,128}:[a-f0-9]{128}$/i.test(encodedHash);
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || typeof encodedHash !== "string") {
    return false;
  }

  const parts = encodedHash.split(":");
  if (parts.length !== 3 || parts[0] !== HASH_SCHEME) {
    return false;
  }

  const [, salt, hashHex] = parts;
  if (
    !/^[a-f0-9]+$/i.test(salt) ||
    !/^[a-f0-9]+$/i.test(hashHex) ||
    hashHex.length !== KEY_BYTES * 2
  ) {
    return false;
  }

  const expectedKey = Buffer.from(hashHex, "hex");
  const actualKey = await deriveKey(password, salt, expectedKey.length);
  return timingSafeEqual(actualKey, expectedKey);
}

function parseBasicAuthorization(headerValue) {
  if (typeof headerValue !== "string") {
    return null;
  }

  const match = headerValue.match(/^Basic\s+([^\s]+)$/i);
  if (!match) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function safeStringEqual(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function createMiddlewareAuth(config = {}, { verify = verifyPassword, now = Date.now } = {}) {
  const username = config.username || process.env.MIDDLEWARE_USER;
  const passwordHash = config.passwordHash || process.env.MIDDLEWARE_PASSWORD_HASH;

  if (typeof username !== "string" || username.trim().length === 0) {
    throw new Error("Missing MIDDLEWARE_USER.");
  }

  if (!validHash(passwordHash)) {
    throw new Error(
      "Missing or invalid MIDDLEWARE_PASSWORD_HASH. Generate credentials with npm run auth:generate."
    );
  }

  const limits = { windowMs: 60_000, maxFailures: 20, maxConcurrent: 2,
    maxVerifications: 60, maxClients: 1000, cacheMs: 300_000, ...config.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid authentication limit: ${name}.`);
  }
  const clients = new Map();
  const cacheKey = randomBytes(32);
  let cachedCredential, cacheExpires = 0, pending = 0;
  let globalWindow = 0, verifications = 0;

  function reject(res) {
    res.set("WWW-Authenticate", 'Basic realm="IoT Electric Middleware", charset="UTF-8"');
    return res.status(401).json({ error: "Authentication required." });
  }

  function limited(res, retryMs) {
    res.set("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))));
    return res.status(429).json({ error: "Too many authentication attempts. Try again later." });
  }

  return async function requireMiddlewareAuthentication(req, res, next) {
    const credentials = parseBasicAuthorization(req.get("authorization"));
    if (!credentials) return reject(res);
    const time = now();
    // Cache only a keyed fingerprint of the one successfully verified account.
    // Polling clients can keep working while invalid credentials are throttled.
    const fingerprint = createHmac("sha256", cacheKey)
      .update(`${credentials.username}:${credentials.password}`).digest();
    if (cachedCredential && time < cacheExpires && timingSafeEqual(fingerprint, cachedCredential)) return next();

    // req.ip uses the socket address unless Express explicitly trusts a proxy.
    // Never read X-Forwarded-For directly for this security boundary.
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    let client = clients.get(ip);
    if (!client) {
      for (const [address, entry] of clients) {
        if (entry.pending === 0 && entry.expires <= time) clients.delete(address);
      }
      if (clients.size >= limits.maxClients) return limited(res, limits.windowMs);
      client = { failures: 0, pending: 0, expires: time + limits.windowMs };
      clients.set(ip, client);
    }
    if (client.expires <= time) {
      client.failures = 0;
      client.expires = time + limits.windowMs;
    }
    // Reserve attempts before awaiting, so parallel failures cannot evade the limit.
    if (client.failures + client.pending >= limits.maxFailures) return limited(res, client.expires - time);
    if (!safeStringEqual(credentials.username, username)) {
      client.failures += 1;
      return reject(res);
    }
    if (time >= globalWindow) { globalWindow = time + limits.windowMs; verifications = 0; }
    if (verifications >= limits.maxVerifications) return limited(res, globalWindow - time);
    if (pending >= limits.maxConcurrent) return limited(res, 1000);

    verifications += 1;
    pending += 1;
    client.pending += 1;
    let authenticated;
    try { authenticated = await verify(credentials.password, passwordHash); }
    catch {
      res.set("Retry-After", "1");
      return res.status(503).json({ error: "Authentication temporarily unavailable." });
    } finally {
      pending -= 1;
      client.pending -= 1;
    }
    if (!authenticated) { client.failures += 1; return reject(res); }
    cachedCredential = fingerprint;
    cacheExpires = now() + limits.cacheMs;
    if (client.failures === 0 && client.pending === 0) clients.delete(ip);

    return next();
  };
}

module.exports = {
  createMiddlewareAuth,
  createPasswordHash,
  parseBasicAuthorization,
  verifyPassword,
};
