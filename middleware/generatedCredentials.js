const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createPasswordHash } = require("./middlewareAuth");

// The dashboard image runs as the "node" user (UID/GID 1000) and reads the
// password from a volume shared with this container, which runs as root.
const DASHBOARD_GID = 1000;

function readPasswordFile(file) {
  const password = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!password || /[\r\n\0]/.test(password)) {
    throw new Error(`MIDDLEWARE_GENERATED_PASSWORD_FILE ${file} must contain a single non-empty line.`);
  }
  return password;
}

// Returns the stack's middleware password, creating it once. An existing file
// is never replaced: the dashboard reads it only at startup, so a new value
// would lock it out until it restarts.
function ensureGeneratedPassword(file, { isRoot = process.getuid?.() === 0 } = {}) {
  try {
    return readPasswordFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o640, flag: "wx" });
    if (isRoot) fs.chownSync(temporary, 0, DASHBOARD_GID);
    try {
      // link() publishes the complete file and fails if another start won.
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return readPasswordFile(file);
}

// Explicit MIDDLEWARE_PASSWORD_HASH always wins. A generated password is used
// only when the deployment names a file for it, such as the Portainer stack.
function resolveMiddlewareCredentials(env = process.env, options) {
  const username = String(env.MIDDLEWARE_USER || "").trim();
  const passwordHash = String(env.MIDDLEWARE_PASSWORD_HASH || "").trim();
  const file = String(env.MIDDLEWARE_GENERATED_PASSWORD_FILE || "").trim();
  if (passwordHash || !file) return { username, passwordHash, generated: false };
  return { username, passwordHash: createPasswordHash(ensureGeneratedPassword(file, options)), generated: true };
}

module.exports = { ensureGeneratedPassword, resolveMiddlewareCredentials };
