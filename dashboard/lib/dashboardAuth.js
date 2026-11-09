const { randomBytes } = require("node:crypto");
const express = require("express");
const { normalizeUsername, verifyPassword } = require("./dashboardUsers");
const { sendEvent } = require("./eventStream");

const cookieName = "iot_dashboard_session";
const sessionDuration = 12 * 60 * 60 * 1000;
const loginWindow = 60_000;
const maxFailures = 20;

const viewerEndpoints = new Set(["/api/config", "/api/devices/settings", "/api/devices/metadata", "/api/snapshot"]);

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
    if (response.locals.dashboardSession) return response.redirect("/");
    return sendLogin(response, users.hasAccounts ? "" : "Računi za prijavu još nisu postavljeni.");
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "8kb" }), async (request, response) => {
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

    endSession(response.locals.dashboardSessionId);
    const id = randomBytes(32).toString("hex");
    const timer = setTimeout(() => endSession(id), sessionDuration).unref();
    sessions.set(id, { username: account.username, role: account.role, roomIds: account.roomIds, timer, streams: new Set() });
    response.cookie(cookieName, id, { ...cookieOptions, maxAge: sessionDuration });
    return response.redirect(303, "/");
  });

  router.post("/logout", (request, response) => {
    endSession(response.locals.dashboardSessionId);
    response.clearCookie(cookieName, cookieOptions);
    return response.redirect(303, "/login");
  });

  router.use((request, response, next) => {
    if (response.locals.dashboardSession) return next();
    if (/^\/(?:api|events)(?:\/|$)/i.test(request.path)) {
      return response.status(401).json({ error: "Potrebna je prijava.", code: "LOGIN_REQUIRED" });
    }
    return response.redirect(303, "/login");
  });

  router.get(["/admin", "/admin.html"], (request, response) => {
    if (response.locals.dashboardSession.role !== "admin") {
      return sendPage(response, "Pristup odbijen", "<h1>Pristup odbijen</h1><p><a href=\"/\">Natrag na dashboard</a></p>", 403);
    }
    return sendPage(response, "Admin", `
      <p><a href="/">Natrag na dashboard</a></p>
      <h1>Korisnici</h1>
      <p>Odaberi koje prostorije korisnik može pregledavati.</p>
      <label for="admin-users">Korisnik</label>
      <select id="admin-users" disabled><option value="">Novi korisnik</option></select>
      <form id="admin-user-form" hidden>
        <label for="admin-username">Korisničko ime</label>
        <input id="admin-username" autocomplete="off" maxlength="128" required>
        <label for="admin-password">Lozinka</label>
        <input id="admin-password" type="password" autocomplete="new-password" maxlength="1024">
        <label><input id="admin-all-rooms" type="checkbox"> Sve prostorije i uređaji bez prostorije</label>
        <fieldset id="admin-room-field">
          <legend>Dozvoljene prostorije</legend>
          <label for="admin-room-search">Pretraži prostorije</label>
          <input id="admin-room-search" type="search" placeholder="Naziv prostorije ili kat" autocomplete="off">
          <div id="admin-rooms" class="dashboard-admin-rooms"></div>
          <p id="admin-rooms-empty" role="status" hidden></p>
        </fieldset>
        <button type="submit">Spremi korisnika</button>
        <button id="admin-delete" type="button" hidden>Izbriši korisnika</button>
      </form>
      <p id="admin-status" role="status" aria-live="polite"></p>`, 200, '<script defer src="/adminUsers.js"></script>');
  });

  router.use((request, response, next) => {
    if (response.locals.dashboardSession.role === "admin") return next();
    const pathname = request.path.toLowerCase().replace(/\/$/, "");
    const read = request.method === "GET" || request.method === "HEAD";
    if (read && (!/^\/api(?:\/|$)/.test(pathname) || viewerEndpoints.has(pathname))) return next();
    return response.status(403).json({ error: "Ova radnja zahtijeva administratorski pristup.", code: "ADMIN_REQUIRED" });
  });

  function revoke(username) {
    for (const [id, session] of sessions) {
      if (session.role === "user" && session.username === username) endSession(id);
    }
  }

  return { router, users, revoke };
}

function trackDashboardStream(response) {
  const session = response.locals.dashboardSession;
  if (!session) return;
  session.streams.add(response);
  response.once("close", () => session.streams.delete(response));
}

module.exports = { createDashboardAuth, trackDashboardStream };
