const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const deriveKey = promisify(scrypt);
const hashPattern = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/;

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 1024) return false;
  const [, salt, key] = hashPattern.exec(encoded);
  return timingSafeEqual(await deriveKey(password, salt, 64), Buffer.from(key, "hex"));
}

function accountError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().normalize("NFC") : "";
}

function validRoomIds(roomIds) {
  return roomIds === null || Array.isArray(roomIds) && roomIds.length <= 50_000
    && roomIds.every(id => typeof id === "string" && id.trim() && id.length <= 4096);
}

function loadBootstrapAccount(env, prefix, role) {
  const username = normalizeUsername(env[`${prefix}_USER`]);
  const password = env[`${prefix}_PASSWORD`];
  if (!username && !password) return null;
  if (!username || username.length > 128 || !password?.trim() || password.length > 1024) {
    throw new Error(`Set a valid ${prefix}_USER and ${prefix}_PASSWORD.`);
  }
  return { username, passwordHash: hashPassword(password), role, roomIds: null };
}

function publicAccount({ username, roomIds }) {
  return { username, roomIds };
}

class DashboardUsers {
  #users;
  #admin;
  #file;
  #database;

  constructor(file, env, { database } = {}) {
    this.#file = file;
    this.#database = database;
    this.#admin = loadBootstrapAccount(env, "DASHBOARD_ADMIN", "admin");
    const stored = database?.readUsers();
    const users = stored ?? this.#readLegacyUsers(env);
    this.#users = new Map();
    for (const { username, passwordHash, roomIds } of users) {
      if (!username || username !== normalizeUsername(username) || username.length > 128
        || this.#users.has(username) || username === this.#admin?.username
        || typeof passwordHash !== "string" || !hashPattern.test(passwordHash) || !validRoomIds(roomIds)) {
        throw new Error("Neispravni računi ili korisničko ime administratora već postoji među običnim korisnicima.");
      }
      this.#users.set(username, { username, passwordHash, roomIds, role: "user" });
    }
    if (database && stored === undefined) database.saveUsers(this.#users.values());
  }

  #readLegacyUsers(env) {
    let raw;
    try {
      raw = fs.readFileSync(this.#file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const operator = loadBootstrapAccount(env, "DASHBOARD_LOGIN", "user");
      if (operator?.username === this.#admin?.username && operator) {
        throw new Error("Dashboard user and admin must have different usernames.");
      }
      return operator ? [operator] : [];
    }
    try {
      const { version, users } = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (version !== 1 || !Array.isArray(users)) throw new Error();
      if (users.some(user => !user || typeof user !== "object")) throw new Error();
      return users;
    } catch {
      throw new Error("Datoteka dashboard-users.json nije valjana.");
    }
  }

  get hasAccounts() { return Boolean(this.#admin) || this.#users.size > 0; }

  find(username) {
    if (username === this.#admin?.username) return this.#admin;
    return this.#users.get(username);
  }

  list() { return [...this.#users.values()].map(publicAccount); }

  save(previousUsername, body, availableRooms) {
    const username = normalizeUsername(body?.username);
    const password = body?.password ?? "";
    const roomIds = body?.roomIds;
    if (!username || username.length > 128 || /[\x00-\x1f\x7f]/.test(username)) throw accountError("Upiši valjano korisničko ime do 128 znakova.");
    if (!validRoomIds(roomIds) || roomIds?.some(id => !availableRooms.has(id))) throw accountError("Odaberi postojeće prostorije.");
    const previous = previousUsername === null ? null : this.#users.get(previousUsername);
    if (previousUsername !== null && !previous) throw accountError("Korisnik više ne postoji.", 404);
    if (username === this.#admin?.username || username !== previousUsername && this.#users.has(username)) {
      throw accountError("Korisničko ime je već zauzeto.", 409);
    }
    if (typeof password !== "string" || (password || !previous) && (password.trim().length < 8 || password.length > 1024)) {
      throw accountError("Nova lozinka mora imati od 8 do 1024 znakova.");
    }
    const user = {
      username,
      passwordHash: password ? hashPassword(password) : previous.passwordHash,
      roomIds: roomIds === null ? null : [...new Set(roomIds)],
      role: "user",
    };
    const users = new Map(this.#users);
    if (previousUsername !== username) users.delete(previousUsername);
    users.set(username, user);
    this.#write(users);
    return publicAccount(user);
  }

  remove(username) {
    if (!this.#users.has(username)) throw accountError("Korisnik više ne postoji.", 404);
    const users = new Map(this.#users);
    users.delete(username);
    this.#write(users);
  }

  #write(users) {
    const temporary = this.#database ? null : `${this.#file}.${randomUUID()}.tmp`;
    try {
      if (this.#database) this.#database.saveUsers(users.values());
      else {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
        const document = { version: 1, users: [...users.values()].map(({ username, passwordHash, roomIds }) => ({ username, passwordHash, roomIds })) };
        fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, this.#file);
      }
    } catch {
      throw accountError("Spremanje korisnika nije uspjelo. Prethodni podaci su sačuvani.", 500);
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    }
    this.#users = users;
  }
}

module.exports = { DashboardUsers, normalizeUsername, verifyPassword };
