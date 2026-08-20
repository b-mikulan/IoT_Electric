const {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");

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

function verifyPassword(password, encodedHash) {
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
  const actualKey = scryptSync(password, salt, expectedKey.length);
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

function createMiddlewareAuth(config = {}) {
  const username = config.username || process.env.MIDDLEWARE_USER;
  const passwordHash = config.passwordHash || process.env.MIDDLEWARE_PASSWORD_HASH;

  if (typeof username !== "string" || username.trim().length === 0) {
    throw new Error("Missing MIDDLEWARE_USER.");
  }

  if (typeof passwordHash !== "string" || !passwordHash.startsWith(`${HASH_SCHEME}:`)) {
    throw new Error(
      "Missing or invalid MIDDLEWARE_PASSWORD_HASH. Generate credentials with npm run auth:generate."
    );
  }

  return function requireMiddlewareAuthentication(req, res, next) {
    const credentials = parseBasicAuthorization(req.get("authorization"));
    const authenticated =
      credentials &&
      safeStringEqual(credentials.username, username) &&
      verifyPassword(credentials.password, passwordHash);

    if (!authenticated) {
      res.set(
        "WWW-Authenticate",
        'Basic realm="IoT Electric Middleware", charset="UTF-8"'
      );
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    return next();
  };
}

module.exports = {
  createMiddlewareAuth,
  createPasswordHash,
  parseBasicAuthorization,
  verifyPassword,
};
