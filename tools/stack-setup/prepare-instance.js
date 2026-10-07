#!/usr/bin/env node
// Also runnable through prepare-instance.sh without installing Node on the server.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createInterface } = require("node:readline/promises");
const { Writable } = require("node:stream");
const { createPasswordHash } = require("../../middleware/middlewareAuth");
const { parseWidgets } = require("../../dashboard/lib/config");

const HELP = `Priprema nove IoT Electric instance za Linux / Portainer.

sudo bash tools/stack-setup/prepare-instance.sh --name cnus \\
  --ews-url https://controller.example/EcoStruxure/DataExchange \\
  --ews-user ews-user --point-id '01/ES/Building/Temperature' \\
  --middleware-port 3100 --dashboard-port 3101 --image-tag 0.3.0

Opcije:
  --name NAZIV             Obavezno; mala slova, brojevi i crtice.
  --base-dir PUTANJA       Osnovni folder (zadano /opt/iot-electric).
  --ews-url URL            Puni EWS endpoint; pita ako nije zadan.
  --ews-user KORISNIK      EWS korisnik; pita ako nije zadan.
  --point-id ID            Prva stvarna vrijednost, dodana kao read-only widget.
  --widgets DATOTEKA       Postojeci widgets.json umjesto --point-id.
  --middleware-port PORT   Vanjski middleware port (zadano 3000).
  --dashboard-port PORT    Vanjski dashboard port (zadano 3001).
  --image-tag TAG          Obavezno; vec objavljena verzija obje slike, bez v.
  --connection-file FILE  JSON s url, username, password za pripremu bez pitanja.
  --help                  Ove upute.

EWS lozinka unosi se skriveno. Skripta ne deploya stack i ne mijenja
postojecu instancu. Node >=24 ili Docker potreban je za shell wrapper.
`;

function parseArgs(args) {
  const allowed = new Set(["name", "base-dir", "ews-url", "ews-user", "point-id",
    "widgets", "middleware-port", "dashboard-port", "image-tag", "connection-file"]);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--help") return { help: true };
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed.has(key)) {
      throw new Error(`Nepoznata opcija: ${args[i]}`);
    }
    if (options[key] !== undefined) throw new Error(`Opcija --${key} je ponovljena.`);
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Nedostaje vrijednost za --${key}.`);
    }
    options[key] = args[++i];
  }
  return options;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} mora biti neprazan tekst u jednom retku.`);
  }
  return value;
}

function port(value, label) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${label} mora biti broj od 1 do 65535.`);
  }
  return Number(value);
}

function envValue(value) {
  // Compose single quotes preserve $, #, spaces and literal backslashes.
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

function validateOptions(options) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.name || "")) {
    throw new Error("--name mora poceti malim slovom i sadrzavati samo mala slova, brojeve i crtice (do 63 znaka).");
  }
  if (options.widgets && options["point-id"]) {
    throw new Error("Odaberi --widgets ili --point-id.");
  }
  const middlewarePort = port(options["middleware-port"] || "3000", "Middleware port");
  const dashboardPort = port(options["dashboard-port"] || "3001", "Dashboard port");
  if (middlewarePort === dashboardPort) throw new Error("Portovi moraju biti razliciti.");
  const imageTag = options["image-tag"];
  if (!imageTag || !/^[\w][\w.-]{0,127}$/.test(imageTag)) {
    throw new Error("Zadaj --image-tag s vec objavljenom verzijom obje slike, npr. 0.5.0 (bez v).");
  }
  const baseDir = path.resolve(options["base-dir"] || "/opt/iot-electric");
  const instanceDir = path.join(baseDir, options.name);
  if (fs.existsSync(instanceDir)) {
    throw new Error(`Instanca vec postoji: ${instanceDir}. Postojeci fajlovi nisu promijenjeni.`);
  }
  // Check saved instances as well as ports currently listening on the server.
  if (fs.existsSync(baseDir)) {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const envFile = path.join(baseDir, entry.name, ".env");
      if (!fs.existsSync(envFile)) continue;
      const saved = fs.readFileSync(envFile, "utf8");
      const matches = saved.matchAll(/^(?:MIDDLEWARE|DASHBOARD)_HOST_PORT=['"]?(\d+)/gm);
      for (const match of matches) {
        if ([middlewarePort, dashboardPort].includes(Number(match[1]))) {
          throw new Error(`Port ${match[1]} vec koristi pripremljena instanca ${entry.name}. Odaberi druge portove.`);
        }
      }
    }
  }
  return { middlewarePort, dashboardPort, imageTag, baseDir, instanceDir };
}

async function checkPorts(ports) {
  const net = require("node:net");
  const listeners = [];
  try {
    for (const value of ports) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", () => reject(new Error(`Port ${value} nije slobodan na serveru.`)));
        server.listen(value, "0.0.0.0", resolve);
      });
      listeners.push(server);
    }
  } finally {
    await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function checkPublishedPorts(ports) {
  let published = process.env.STACK_SETUP_PUBLISHED_PORTS;
  if (published === undefined) {
    const { execFileSync } = require("node:child_process");
    try { published = execFileSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error("Nije moguce provjeriti Docker portove. Provjeri radi li Docker daemon.");
    }
  }
  for (const match of published.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    for (const value of ports) {
      if (value >= first && value <= last) throw new Error(`Port ${value} vec je objavljen kroz Docker.`);
    }
  }
}

function readJson(file, label) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, ""); }
  catch { throw new Error(`Nije moguce procitati ${label}.`); }
  try { return JSON.parse(raw); }
  catch { throw new Error(`${label} nije valjan JSON.`); }
}

function prepareInstance(options, connection) {
  const settings = validateOptions(options);
  const urlText = text(connection.url, "EWS URL").trim();
  let url;
  try { url = new URL(urlText); } catch { throw new Error("EWS URL nije valjan URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("EWS URL mora koristiti http ili https, bez korisnika/lozinke u URL-u.");
  }
  text(connection.username, "EWS korisnik");
  text(connection.password, "EWS lozinka");
  let widgets;
  if (options.widgets) {
    widgets = readJson(options.widgets, "widget datoteku");
  } else {
    widgets = [{ id: text(options["point-id"], "ID prve EWS vrijednosti"),
      label: "Testna vrijednost", unit: "", writable: false }];
  }
  parseWidgets(JSON.stringify(widgets), false);
  const password = randomBytes(24).toString("base64url");
  const configDir = path.join(settings.instanceDir, "dashboard-config");
  const env = {
    COMPOSE_PROJECT_NAME: options.name,
    IMAGE_TAG: settings.imageTag,
    MIDDLEWARE_HOST_PORT: String(settings.middlewarePort),
    DASHBOARD_HOST_PORT: String(settings.dashboardPort),
    EWS_URL: urlText,
    EWS_USER: connection.username,
    EWS_PASSWORD: connection.password,
    MIDDLEWARE_USER: `${options.name}-admin`,
    MIDDLEWARE_PASSWORD_HASH: createPasswordHash(password),
    DASHBOARD_MIDDLEWARE_PASSWORD: password,
    DASHBOARD_MIDDLEWARE_PASSWORD_FILE: "",
    DASHBOARD_DEMO_MODE: "false",
    DASHBOARD_POLL_INTERVAL_MS: "15000",
    DASHBOARD_MIDDLEWARE_TIMEOUT_MS: "10000",
    DASHBOARD_CONFIG_SOURCE: configDir.split(path.sep).join("/"),
    DASHBOARD_WIDGETS_FILE: "/app/config/widgets.json",
    DASHBOARD_WIDGETS_JSON: "",
  };
  const template = fs.readFileSync(path.resolve(__dirname, "../../docker-compose.portainer.yml"), "utf8");
  const dotenv = Object.entries(env).map(([key, value]) => `${key}=${envValue(value)}`).join("\n") + "\n";
  // Portainer's file importer preserves quote characters; it expects raw values.
  const portainerEnv = Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  const instructions = `Instanca: ${options.name}
Middleware port: ${settings.middlewarePort}
Dashboard port: ${settings.dashboardPort}

Portainer (Docker Standalone):
1. Stacks > Add stack; naziv ${options.name}.
2. Upload docker-compose.yml ili zalijepi sadrzaj u Web editor.
3. Load variables from .env file: ucitaj portainer.env (ne .env za CLI).
4. Deploy the stack.

Alternativno Docker Compose na ovom serveru:
cd '${settings.instanceDir.replace(/'/g, "'\\''")}'
docker compose up -d
docker compose logs -f middleware dashboard

Middleware korisnik: ${env.MIDDLEWARE_USER}
Lozinka: DASHBOARD_MIDDLEWARE_PASSWORD u .env (za Swagger /api-docs).

.env i portainer.env sadrze lozinke; cuvaj ih kao privatne fajlove.
Za promjenu postavki nakon deploya azuriraj varijable u Portaineru.
Promjena lokalnog .env ne azurira varijable postojeceg Portainer stacka.
EWS/TLS vezu provjeri nakon deploya. Slike koriste CA iz middleware Dockerfilea.
`;
  fs.mkdirSync(settings.baseDir, { recursive: true, mode: 0o755 });
  const staging = fs.mkdtempSync(path.join(settings.baseDir, `.setup-${options.name}-`));
  try {
    fs.chmodSync(staging, 0o755);
    const stagingConfig = path.join(staging, "dashboard-config");
    fs.mkdirSync(stagingConfig, { mode: 0o750 });
    fs.chmodSync(stagingConfig, 0o750);
    const widgetFile = path.join(stagingConfig, "widgets.json");
    fs.writeFileSync(widgetFile, JSON.stringify(widgets, null, 2) + "\n", { mode: 0o640 });
    fs.chmodSync(widgetFile, 0o640);
    if (process.platform === "linux") {
      fs.chownSync(stagingConfig, 1000, 1000);
      fs.chownSync(widgetFile, 1000, 1000);
    }
    fs.writeFileSync(path.join(staging, ".env"), dotenv, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, "docker-compose.yml"), template, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, "portainer.env"), portainerEnv, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, "DEPLOY.txt"), instructions, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, ".gitignore"), "# Local instance data and credentials\n*\n", { mode: 0o600 });
    // Exclusive directory reservation prevents concurrent runs overwriting an instance.
    fs.mkdirSync(settings.instanceDir, { mode: 0o755 });
    fs.chmodSync(settings.instanceDir, 0o755);
    for (const entry of fs.readdirSync(staging)) {
      fs.renameSync(path.join(staging, entry), path.join(settings.instanceDir, entry));
    }
  } finally {
    if (path.dirname(staging) !== settings.baseDir || !path.basename(staging).startsWith(`.setup-${options.name}-`)) {
      throw new Error("Neispravna putanja privremene pripreme.");
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return settings;
}

async function ask(label, secret = false) {
  if (!process.stdin.isTTY) {
    throw new Error(`Nedostaje ${label}. Za pripremu bez pitanja koristi --connection-file i --widgets/--point-id.`);
  }
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!secret) process.stdout.write(chunk);
    callback();
  } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(`${label}: `);
  try { return await input.question(""); }
  finally { input.close(); if (secret) process.stdout.write("\n"); }
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  const settings = validateOptions(options);
  if (process.platform === "linux" && process.getuid() !== 0) {
    throw new Error("Pokreni sa sudo radi dodjele dashboard-config foldera korisniku UID 1000.");
  }
  process.umask(0o022);
  checkPublishedPorts([settings.middlewarePort, settings.dashboardPort]);
  await checkPorts([settings.middlewarePort, settings.dashboardPort]);
  let connection = {};
  if (options["connection-file"]) {
    connection = readJson(options["connection-file"], "connection-file");
    if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
      throw new Error("connection-file mora sadrzavati JSON objekt s url, username i password.");
    }
  }
  connection.url = options["ews-url"] || connection.url || await ask("EWS URL");
  connection.username = options["ews-user"] || connection.username || await ask("EWS korisnik");
  connection.password = connection.password || await ask("EWS lozinka", true);
  if (!options.widgets && !options["point-id"]) options["point-id"] = await ask("ID prve EWS vrijednosti");
  const result = prepareInstance(options, connection);
  console.log(`Pripremljena instanca: ${result.instanceDir}`);
  console.log("Portainer: ucitaj docker-compose.yml i varijable iz portainer.env.");
  console.log(`Portovi: middleware ${result.middlewarePort}, dashboard ${result.dashboardPort}.`);
  console.log("Lozinke i upute su u .env i DEPLOY.txt; stack jos nije deployan.");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Priprema nije uspjela: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validateOptions, prepareInstance, checkPorts, checkPublishedPorts };
