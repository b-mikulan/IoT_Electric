const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");
const { verifyPassword } = require("../middleware/middlewareAuth");
const { loadConfig } = require("../dashboard/lib/config");
const { prepareInstance, validateOptions, checkPorts, checkPublishedPorts } = require("../tools/stack-setup/prepare-instance");

const connection = { url: "https://controller.example:60588/EcoStruxure/DataExchange", username: "ews-user", password: "test$Password#with=equals" };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iot-stack-test-"));
  // Ownership needs a real root Linux host; all other preparation is exercised here.
  t.mock.method(fs, "chownSync", () => {});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { name: "first", "base-dir": root, "image-tag": "0.5.0", "point-id": "01/ES/Test/Temperature" };
}

function portainerEnv(file) {
  // Same raw key/value behavior as Portainer's upload importer.
  return Object.fromEntries(fs.readFileSync(file, "utf8").trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

test("prepares usable live configuration, matching credentials and independent instances", (t) => {
  const options = fixture(t);
  const first = prepareInstance(options, connection);
  const env = dotenv.parse(fs.readFileSync(path.join(first.instanceDir, ".env")));
  const imported = portainerEnv(path.join(first.instanceDir, "portainer.env"));
  assert.equal(imported.EWS_PASSWORD, connection.password);
  assert.deepEqual(imported, env);
  assert.equal(verifyPassword(env.DASHBOARD_MIDDLEWARE_PASSWORD, env.MIDDLEWARE_PASSWORD_HASH), true);
  const config = loadConfig({ DEMO_MODE: env.DASHBOARD_DEMO_MODE,
    MIDDLEWARE_USER: env.MIDDLEWARE_USER, MIDDLEWARE_PASSWORD: env.DASHBOARD_MIDDLEWARE_PASSWORD,
    WIDGETS_FILE: path.join(first.instanceDir, "dashboard-config/widgets.json") });
  assert.equal(config.demoMode, false);
  assert.equal(config.widgets[0].id, options["point-id"]);
  assert.equal(config.widgets[0].writable, false);
  assert.equal(env.DASHBOARD_CONFIG_SOURCE, path.join(first.instanceDir, "dashboard-config").split(path.sep).join("/"));
  const compose = fs.readFileSync(path.join(first.instanceDir, "docker-compose.yml"), "utf8");
  assert.match(compose, /\$\{MIDDLEWARE_HOST_PORT:-3000\}:3000/);
  assert.match(compose, /\$\{DASHBOARD_HOST_PORT:-3001\}:3001/);
  assert.equal(compose.includes(connection.password), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(first.instanceDir, "portainer.env")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(first.instanceDir, "dashboard-config")).mode & 0o777, 0o750);
  }
  const second = prepareInstance({ ...options, name: "second", "middleware-port": "3100", "dashboard-port": "3101" }, connection);
  const secondEnv = portainerEnv(path.join(second.instanceDir, "portainer.env"));
  assert.notEqual(secondEnv.MIDDLEWARE_USER, env.MIDDLEWARE_USER);
  assert.notEqual(secondEnv.DASHBOARD_MIDDLEWARE_PASSWORD, env.DASHBOARD_MIDDLEWARE_PASSWORD);
  assert.notEqual(secondEnv.DASHBOARD_CONFIG_SOURCE, env.DASHBOARD_CONFIG_SOURCE);
});

test("never overwrites an existing instance or reserves another instance's ports", (t) => {
  const options = fixture(t);
  const prepared = prepareInstance(options, connection);
  const file = path.join(prepared.instanceDir, "dashboard-config/widgets.json");
  fs.writeFileSync(file, "user edited contents");
  assert.throws(() => prepareInstance(options, connection), /vec postoji/);
  assert.equal(fs.readFileSync(file, "utf8"), "user edited contents");
  assert.throws(() => prepareInstance({ ...options, name: "other" }, connection), /vec koristi/);
  assert.equal(fs.existsSync(path.join(options["base-dir"], "other")), false);
});

test("validates names, ports, URLs and widget files before creating an instance", (t) => {
  const options = fixture(t);
  for (const name of ["../escape", "Bad Name", "-wrong"]) {
    assert.throws(() => validateOptions({ ...options, name }), /--name/);
  }
  assert.throws(() => validateOptions({ ...options, "image-tag": "" }), /--image-tag/);
  assert.throws(() => validateOptions({ ...options, "middleware-port": "0" }), /65535/);
  assert.throws(() => validateOptions({ ...options, "dashboard-port": "3000" }), /razliciti/);
  assert.throws(() => prepareInstance(options, { ...connection, url: "ftp://controller.example" }), /http/);
  const widgets = path.join(options["base-dir"], "widgets.json");
  fs.writeFileSync(widgets, "[]");
  const { "point-id": _point, ...withoutPoint } = options;
  assert.throws(() => prepareInstance({ ...withoutPoint, widgets }, connection), /non-empty/);
  fs.writeFileSync(widgets, '[{"id":"same"},{"id":"same"}]');
  assert.throws(() => prepareInstance({ ...withoutPoint, widgets }, connection), /duplicate/);
  assert.equal(fs.existsSync(path.join(options["base-dir"], options.name)), false);
  const original = [{ id: "existing", writable: true, visible: false, label: "Existing" }];
  fs.writeFileSync(widgets, JSON.stringify(original));
  const result = prepareInstance({ ...withoutPoint, widgets }, connection);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.instanceDir, "dashboard-config/widgets.json"))), original);
});

test("detects listening ports and Docker publications without leaving a listener", async (t) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
  const occupied = listener.address().port;
  try { await assert.rejects(checkPorts([occupied]), /nije slobodan/); }
  finally { await new Promise((resolve) => listener.close(resolve)); }
  await checkPorts([occupied]);
  const previous = process.env.STACK_SETUP_PUBLISHED_PORTS;
  t.after(() => {
    if (previous === undefined) delete process.env.STACK_SETUP_PUBLISHED_PORTS;
    else process.env.STACK_SETUP_PUBLISHED_PORTS = previous;
  });
  process.env.STACK_SETUP_PUBLISHED_PORTS = "0.0.0.0:3100->3000/tcp, [::]:3101->3001/tcp, 127.0.0.1:3200-3205->80-85/tcp";
  assert.throws(() => checkPublishedPorts([3101]), /objavljen/);
  assert.throws(() => checkPublishedPorts([3203]), /objavljen/);
  checkPublishedPorts([3300, 3301]);
});

test("CLI preparation and errors never print secrets", (t) => {
  const options = fixture(t);
  const script = path.resolve(__dirname, "../tools/stack-setup/prepare-instance.js");
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--name/);
  const file = path.join(options["base-dir"], "private.json");
  fs.writeFileSync(file, '{"password":"never-print-this-secret", BROKEN}');
  // Root is required for real Linux CLI calls; this test exercises the read/error path on Windows.
  if (process.platform === "linux" && process.getuid() !== 0) return;
  const invalid = spawnSync(process.execPath, [script, "--name", "invalid", "--base-dir", options["base-dir"],
    "--image-tag", "0.5.0", "--connection-file", file, "--point-id", "point",
    "--middleware-port", "49191", "--dashboard-port", "49192"], {
    encoding: "utf8", env: { ...process.env, STACK_SETUP_PUBLISHED_PORTS: "" },
  });
  assert.equal(invalid.status, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes("never-print-this-secret"), false);
  assert.equal(fs.existsSync(path.join(options["base-dir"], "invalid")), false);
  fs.writeFileSync(file, JSON.stringify(connection));
  const valid = spawnSync(process.execPath, [script, "--name", "valid", "--base-dir", options["base-dir"],
    "--image-tag", "0.5.0", "--connection-file", file, "--point-id", "real-point",
    "--middleware-port", "49191", "--dashboard-port", "49192"], {
    encoding: "utf8", env: { ...process.env, STACK_SETUP_PUBLISHED_PORTS: "" },
  });
  assert.equal(valid.status, 0, valid.stderr);
  const generated = portainerEnv(path.join(options["base-dir"], "valid/portainer.env"));
  for (const secret of [connection.password, generated.DASHBOARD_MIDDLEWARE_PASSWORD, generated.MIDDLEWARE_PASSWORD_HASH]) {
    assert.equal((valid.stdout + valid.stderr).includes(secret), false);
  }
  assert.equal(fs.existsSync(path.join(options["base-dir"], "valid/dashboard-config/widgets.json")), true);
  assert.equal(fs.readFileSync(path.join(options["base-dir"], "valid/.gitignore"), "utf8").includes("*"), true);
});
