const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPasswordHash, verifyPassword } = require("../middleware/middlewareAuth");
const { ensureGeneratedPassword, resolveMiddlewareCredentials } = require("../middleware/generatedCredentials");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "middleware-credentials-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("creates the shared password once and reuses it on later starts", async (t) => {
  const file = path.join(directory(t), "secrets", "middleware-password");
  const env = { MIDDLEWARE_USER: "iot-electric", MIDDLEWARE_GENERATED_PASSWORD_FILE: file };
  const first = resolveMiddlewareCredentials(env, { isRoot: false });
  assert.equal(first.generated, true);
  assert.equal(first.username, "iot-electric");
  const password = fs.readFileSync(file, "utf8").trim();
  assert.ok(password.length >= 32);
  assert.equal(await verifyPassword(password, first.passwordHash), true);
  const second = resolveMiddlewareCredentials(env, { isRoot: false });
  assert.equal(fs.readFileSync(file, "utf8").trim(), password);
  assert.equal(await verifyPassword(password, second.passwordHash), true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["middleware-password"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test("gives the dashboard group read access when running as root", (t) => {
  const file = path.join(directory(t), "middleware-password");
  const calls = [];
  t.mock.method(fs, "chownSync", (...args) => calls.push(args.slice(1)));
  ensureGeneratedPassword(file, { isRoot: true });
  assert.deepEqual(calls, [[0, 1000]]);
});

test("keeps an existing file and rejects a damaged one instead of replacing it", (t) => {
  const file = path.join(directory(t), "middleware-password");
  fs.writeFileSync(file, "chosen-by-operator\n");
  assert.equal(ensureGeneratedPassword(file, { isRoot: false }), "chosen-by-operator");
  fs.writeFileSync(file, "");
  assert.throws(() => ensureGeneratedPassword(file, { isRoot: false }), /single non-empty line/);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("explicit credentials win and nothing is generated without a configured file", (t) => {
  const file = path.join(directory(t), "middleware-password");
  const hash = createPasswordHash("explicit-password");
  const explicit = resolveMiddlewareCredentials({ MIDDLEWARE_USER: "site-admin", MIDDLEWARE_PASSWORD_HASH: hash,
    MIDDLEWARE_GENERATED_PASSWORD_FILE: file });
  assert.deepEqual(explicit, { username: "site-admin", passwordHash: hash, generated: false });
  assert.equal(fs.existsSync(file), false);
  assert.equal(resolveMiddlewareCredentials({ MIDDLEWARE_USER: "local" }).generated, false);
});
