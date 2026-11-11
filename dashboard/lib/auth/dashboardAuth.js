const { randomBytes } = require("node:crypto");
const express = require("express");
const { normalizeUsername, validPassword, verifyPassword } = require("./dashboardUsers");
const { sendEvent } = require("../http/eventStream");
const { sendAdminPage } = require("../http/adminPage");

const cookieName = "iot_dashboard_session";
const sessionDuration = 12 * 60 * 60 * 1000;
const setupDuration = 15 * 60 * 1000;
const setupPath = "/setup-password";
const loginWindow = 60_000;
const maxFailures = 20;

const viewerEndpoints = new Set(["/api/config", "/api/devices/settings", "/api/devices/metadata", "/api/snapshot", "/api/history/catalog"]);
const userPostEndpoints = new Set(["/api/devices/write", "/api/dashboard/refresh-scope", "/api/history/query", "/api/history/browse", "/api/alarms/query"]);

function sendPage(response, title, content, status = 200, script = "") {
  return response.status(status).set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; form-action 'self'").send(`<!doctype html>
<html lang="hr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · IoT Electric</title>
    <link rel="icon" href="/favicon.svg">
    <link rel="stylesheet" href="/styles.css">
    ${script}
  </head>
  <body class="dashboard-auth-page">
    <main class="dashboard-auth-panel">${content}</main>
  </body>
</html>`);
}

function sendLogin(response, message = "", status = 200) {
  return sendPage(response, "Prijava", `
    <p class="eyebrow">IoT Electric</p>
    <h1>Prijava</h1>
    ${message ? `<p class="dashboard-auth-error" role="alert">${message}</p>` : ""}
    <form method="post" action="/login">
      <label for="username">Korisničko ime</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">Lozinka</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Prijavi se</button>
    </form>`, status);
}

function sendPasswordSetup(response, message = "", status = 200) {
  return sendPage(response, "Postavi lozinku", `
    <p class="eyebrow">IoT Electric</p>
    <h1>Postavi svoju lozinku</h1>
    <p>Za pristup dashboardu zamijeni privremenu lozinku svojom. Upiši najmanje 8 znakova.</p>
    ${message ? `<p class="dashboard-auth-error" role="alert">${message}</p>` : ""}
    <form method="post" action="${setupPath}">
      <label for="password">Nova lozinka</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required>
      <label for="confirmation">Ponovi novu lozinku</label>
      <input id="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required>
      <button type="submit">Spremi lozinku i nastavi</button>
    </form>
    <form method="post" action="/logout"><button type="submit">Odjava</button></form>`, status);
}

function createDashboardAuth(env, users) {
  const router = express.Router();
  const sessions = new Map();
  const failuresByIp = new Map();
  let pendingVerifications = 0;
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: env.DASHBOARD_SECURE_COOKIES === "true",
    path: "/",
  };

  function endSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    for (const stream of session.streams) {
      sendEvent(stream, "session-ended", {});
      stream.end();
    }
  }

  function beginSession(response, account) {
    endSession(response.locals.dashboardSessionId);
    const id = randomBytes(32).toString("hex");
    const mustChangePassword = account.mustChangePassword === true;
    const duration = mustChangePassword ? setupDuration : sessionDuration;
    const timer = setTimeout(() => endSession(id), duration).unref();
    sessions.set(id, {
      username: account.username, role: account.role, roomIds: account.roomIds,
      writeRoomIds: account.writeRoomIds, canEditDeviceSettings: account.canEditDeviceSettings,
      mustChangePassword, timer, streams: new Set(),
    });
    response.cookie(cookieName, id, { ...cookieOptions, maxAge: duration });
    return response.redirect(303, mustChangePassword ? setupPath : "/");
  }

  const isDataRequest = request => /^\/(?:api|events)(?:\/|$)/i.test(request.path);

  router.get(["/health", "/ready", "/styles.css", "/favicon.svg"], (request, response, next) => next("router"));

  router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    const site = request.get("Sec-Fetch-Site");
    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (!safeMethod && (site === "cross-site" || site === "same-site")) {
      return response.status(403).json({ error: "Zahtjev mora doći s dashboarda." });
    }

    const cookie = request.get("Cookie")?.match(/(?:^|;\s*)iot_dashboard_session=([a-f0-9]{64})(?:;|$)/);
    response.locals.dashboardSessionId = cookie?.[1];
    response.locals.dashboardSession = sessions.get(cookie?.[1]);
    response.locals.isSessionActive = () => sessions.has(cookie?.[1]);
    return next();
  });

  router.get("/login", (request, response) => {
    const session = response.locals.dashboardSession;
    if (session) return response.redirect(session.mustChangePassword ? setupPath : "/");
    return sendLogin(response, users.hasAccounts ? "" : "Računi za prijavu još nisu postavljeni.");
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "16kb" }), async (request, response) => {
    if (!users.hasAccounts) return sendLogin(response, "Računi za prijavu još nisu postavljeni.", 503);
    const ip = request.ip;
    if ((failuresByIp.get(ip) ?? 0) >= maxFailures || pendingVerifications >= 4) {
      response.set("Retry-After", String(loginWindow / 1000));
      return sendLogin(response, "Previše pokušaja. Pokušaj ponovno za minutu.", 429);
    }

    const { username, password } = request.body || {};
    const name = normalizeUsername(username);
    const account = users.find(name);
    let verified = false;
    if (account) {
      pendingVerifications += 1;
      try { verified = await verifyPassword(password, account.passwordHash); }
      finally { pendingVerifications -= 1; }
    }
    if (!verified || users.find(name) !== account) {
      const failures = failuresByIp.get(ip) ?? 0;
      if (failures === 0) setTimeout(() => failuresByIp.delete(ip), loginWindow).unref();
      failuresByIp.set(ip, failures + 1);
      return sendLogin(response, "Korisničko ime ili lozinka nisu ispravni.", 401);
    }

    return beginSession(response, account);
  });

  router.post("/logout", (request, response) => {
    endSession(response.locals.dashboardSessionId);
    response.clearCookie(cookieName, cookieOptions);
    return response.redirect(303, "/login");
  });

  router.use((request, response, next) => {
    if (response.locals.dashboardSession) return next();
    if (isDataRequest(request)) {
      return response.status(401).json({ error: "Potrebna je prijava.", code: "LOGIN_REQUIRED" });
    }
    return response.redirect(303, "/login");
  });

  router.get(setupPath, (request, response) => {
    return response.locals.dashboardSession.mustChangePassword ? sendPasswordSetup(response) : response.redirect("/");
  });

  router.post(setupPath, express.urlencoded({ extended: false, limit: "32kb" }), async (request, response) => {
    const { dashboardSession: session, isSessionActive } = response.locals;
    if (!session.mustChangePassword) return response.redirect(303, "/");
    const account = users.find(session.username);
    if (!account?.mustChangePassword) return response.redirect(303, "/login");
    const { password, confirmation } = request.body || {};
    if (!validPassword(password)) return sendPasswordSetup(response, "Nova lozinka mora imati od 8 do 1024 znakova.", 400);
    if (password !== confirmation) return sendPasswordSetup(response, "Lozinke se ne podudaraju.", 400);
    if (pendingVerifications >= 4) {
      response.set("Retry-After", "1");
      return sendPasswordSetup(response, "Pokušaj ponovno za nekoliko trenutaka.", 429);
    }

    let matchesTemporaryPassword;
    pendingVerifications += 1;
    try { matchesTemporaryPassword = await verifyPassword(password, account.passwordHash); }
    finally { pendingVerifications -= 1; }
    if (!isSessionActive() || users.find(account.username) !== account) return response.redirect(303, "/login");
    if (matchesTemporaryPassword) return sendPasswordSetup(response, "Odaberi lozinku različitu od privremene.", 400);

    let updated;
    try { updated = users.completePasswordSetup(account, password); }
    catch { return sendPasswordSetup(response, "Lozinku nije moguće spremiti. Pokušaj ponovno.", 500); }
    revoke(account.username);
    return beginSession(response, updated);
  });

  router.use((request, response, next) => {
    if (!response.locals.dashboardSession.mustChangePassword) return next();
    if (isDataRequest(request)) {
      return response.status(403).json({ error: "Prvo postavi svoju lozinku.", code: "PASSWORD_SETUP_REQUIRED" });
    }
    return response.redirect(303, setupPath);
  });

  router.get(["/admin", "/admin.html"], (request, response) => {
    if (response.locals.dashboardSession.role !== "admin") {
      return sendPage(response, "Pristup odbijen", "<h1>Pristup odbijen</h1><p><a href=\"/\">Natrag na dashboard</a></p>", 403);
    }
    return sendAdminPage(response);
  });

  router.use((request, response, next) => {
    if (response.locals.dashboardSession.role === "admin") return next();
    const pathname = request.path.toLowerCase().replace(/\/$/, "");
    const read = request.method === "GET" || request.method === "HEAD";
    if (request.method === "POST" && (userPostEndpoints.has(pathname)
      || pathname === "/api/devices/settings" && response.locals.dashboardSession.canEditDeviceSettings === true)) return next();
    if (read && (!/^\/api(?:\/|$)/.test(pathname) || viewerEndpoints.has(pathname))) return next();
    return response.status(403).json({ error: "Ova radnja zahtijeva administratorski pristup.", code: "ADMIN_REQUIRED" });
  });

  function revoke(username) {
    let revoked = 0;
    for (const [id, session] of sessions) {
      if (session.role === "user" && session.username === username) {
        endSession(id);
        revoked += 1;
      }
    }
    return revoked;
  }

  function listSessions(currentSessionId) {
    const accounts = new Map();
    for (const [id, session] of sessions) {
      const account = accounts.get(session.username) || {
        username: session.username, role: session.role, count: 0, current: false,
      };
      account.count += 1;
      account.current ||= id === currentSessionId;
      accounts.set(session.username, account);
    }
    return {
      currentUsername: sessions.get(currentSessionId)?.username ?? null,
      total: sessions.size,
      sessions: [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username, "hr")),
    };
  }

  return { router, users, revoke, listSessions };
}

function trackDashboardStream(response) {
  const session = response.locals.dashboardSession;
  if (!session) return;
  session.streams.add(response);
  response.once("close", () => session.streams.delete(response));
}

module.exports = { createDashboardAuth, trackDashboardStream };
