const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRuntime } = require("../server");

const publicDirectory = path.join(__dirname, "../public");
const styles = fs.readFileSync(path.join(publicDirectory, "shared/styles.css"), "utf8").replace(/\r\n/g, "\n");
const themeScript = fs.readFileSync(path.join(publicDirectory, "shared/theme.js"), "utf8");

function declarations(block) {
  const tokens = new Map();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(match[1], match[2].trim());
  return tokens;
}

function blockAfter(marker) {
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `styles.css has no block starting with ${marker}`);
  const open = styles.indexOf("{", start + marker.length - 1);
  return styles.slice(open + 1, styles.indexOf("}", open));
}

const lightTokens = declarations(blockAfter(':root,\n:root[theme="light"] {'));
const mediaDarkTokens = declarations(blockAfter('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {'));
const attributeDarkTokens = declarations(blockAfter(':root[data-theme="dark"] {'));

function luminance(hex) {
  const channels = hex.replace("#", "").match(/../g).map(value => parseInt(value, 16) / 255);
  const [r, g, b] = channels.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("the dark theme for the system preference and the explicit choice set the same tokens", () => {
  assert.ok(attributeDarkTokens.size > 40);
  assert.deepEqual([...mediaDarkTokens], [...attributeDarkTokens]);
  assert.match(blockAfter(':root[data-theme="dark"] {'), /color-scheme: dark;/);
});

test("every colour token has a dark value and the dark theme adds no unknown token", () => {
  for (const name of attributeDarkTokens.keys()) assert.ok(lightTokens.has(name), `${name} has no light value`);
  for (const [name, value] of lightTokens) {
    if (/#|rgba?\(|url\(/.test(value)) assert.ok(attributeDarkTokens.has(name), `${name} has no dark value`);
  }
});

// Text needs 4.5:1, focus rings, field borders and status lamps 3:1 (WCAG 2.2 AA).
const contrastPairs = [
  ["--ink", "--surface", 4.5], ["--ink", "--canvas", 4.5], ["--ink-2", "--surface", 4.5], ["--ink", "--surface-sunken-2", 4.5],
  ["--muted", "--surface", 4.5], ["--muted", "--canvas", 4.5], ["--muted", "--surface-sunken", 4.5],
  ["--action", "--surface", 4.5], ["--action", "--canvas", 4.5], ["--action-strong", "--action-tint", 4.5],
  ["--on-action", "--action", 4.5], ["--on-action", "--action-strong", 4.5],
  ["--on-alarm", "--alarm", 4.5],
  ["--ok-ink", "--ok-tint", 4.5], ["--warn-ink", "--warn-tint", 4.5], ["--alarm-ink", "--alarm-tint", 4.5],
  ["--ok-ink", "--surface", 4.5], ["--warn-ink", "--surface", 4.5], ["--alarm-ink", "--surface", 4.5],
  ["--focus", "--surface", 3], ["--focus", "--canvas", 3], ["--line-strong", "--surface", 3],
  ["--ok", "--surface", 3], ["--warn", "--surface", 3], ["--alarm", "--surface", 3],
  ["--control-thumb", "--action", 3],
  // Category tones colour icons, which are graphics.
  ...["rust", "teal", "ochre", "violet", "olive", "neutral"].map(tone => [`--tone-${tone}`, `--tone-${tone}-tint`, 3]),
];

// Placeholder text. The light value predates the dark theme and is below 4.5:1 (see docs/ui-style-guide.md).
const darkOnlyPairs = [["--muted-2", "--surface", 4.5], ["--muted-2", "--surface-sunken", 4.5]];

for (const [themeName, tokens, extraPairs] of [["light", lightTokens, []], ["dark", attributeDarkTokens, darkOnlyPairs]]) {
  test(`${themeName} tokens meet WCAG AA contrast`, () => {
    for (const [foreground, background, minimum] of [...contrastPairs, ...extraPairs]) {
      const ratio = contrast(tokens.get(foreground), tokens.get(background));
      assert.ok(ratio >= minimum, `${themeName}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
    }
  });
}

function loadTheme({ stored, systemDark = false, storageThrows = false } = {}) {
  const store = new Map(stored ? [["iotElectric.dashboard.theme", stored]] : []);
  const localStorage = {
    getItem(key) { if (storageThrows) throw new Error("blocked"); return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { if (storageThrows) throw new Error("blocked"); store.set(key, value); },
    removeItem(key) { if (storageThrows) throw new Error("blocked"); store.delete(key); },
  };
  const events = [];
  const document = {
    readyState: "loading",
    documentElement: { dataset: {}, classList: { add() {}, remove() {} } },
    body: null,
    addEventListener() {},
    dispatchEvent(event) { events.push(event.detail); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    localStorage,
    matchMedia: () => ({ matches: systemDark, addEventListener() {} }),
    addEventListener() {},
  };
  vm.runInNewContext(themeScript, { window, document, CustomEvent });
  return { root: document.documentElement, theme: window.IoTTheme, store, events };
}

test("theme.js applies the stored or system theme before the page renders", () => {
  assert.equal(loadTheme({ stored: "dark" }).root.dataset.theme, "dark");
  assert.equal(loadTheme({ stored: "light", systemDark: true }).root.dataset.theme, "light");
  const system = loadTheme({ systemDark: true });
  assert.equal(system.root.dataset.theme, "dark");
  assert.equal(system.root.dataset.themeChoice, "system");
  assert.equal(loadTheme({ stored: "purple" }).root.dataset.themeChoice, "system");
});

test("theme.js remembers the choice and survives blocked storage", () => {
  const page = loadTheme();
  page.theme.set("dark");
  assert.equal(page.store.get("iotElectric.dashboard.theme"), "dark");
  assert.equal(page.root.dataset.theme, "dark");
  assert.deepEqual(page.events.map(detail => ({ ...detail })), [{ theme: "dark", choice: "dark" }]);
  page.theme.set("system");
  assert.equal(page.store.has("iotElectric.dashboard.theme"), false);
  assert.equal(page.root.dataset.theme, "light");

  const blocked = loadTheme({ storageThrows: true, systemDark: true });
  assert.equal(blocked.root.dataset.theme, "dark");
  assert.doesNotThrow(() => blocked.theme.set("light"));
  assert.equal(blocked.root.dataset.theme, "light");
});

async function startDashboard(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "dashboard-theme-"));
  const { app, poller, database } = createRuntime({
    DEMO_MODE: "true",
    DASHBOARD_USERS_FILE: path.join(directory, "dashboard-users.json"),
    DASHBOARD_DB_FILE: path.join(directory, "dashboard.sqlite"),
    DASHBOARD_ADMIN_USER: "admin",
    DASHBOARD_ADMIN_PASSWORD: "test-admin",
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    poller.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    database?.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return (pathname, options) => fetch(baseUrl + pathname, { redirect: "manual", ...options });
}

// A blocking script ahead of the stylesheets is what prevents a light flash.
function assertThemeLoadsFirst(html, page) {
  const script = html.indexOf('<script src="/theme.js"></script>');
  assert.notEqual(script, -1, `${page} does not load theme.js as a blocking script`);
  assert.ok(script < html.indexOf('rel="stylesheet"'), `${page} loads a stylesheet before theme.js`);
  assert.ok(script < html.indexOf("</head>"), `${page} loads theme.js outside <head>`);
}

test("every page applies the theme before its stylesheets, including the sign-in page", async t => {
  const request = await startDashboard(t);
  const script = await request("/theme.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assertThemeLoadsFirst(await (await request("/login")).text(), "/login");

  const signedIn = await request("/login", { method: "POST", body: new URLSearchParams({ username: "admin", password: "test-admin" }) });
  const cookie = signedIn.headers.get("set-cookie").split(";")[0];
  for (const page of ["/", "/technical.html", "/trends.html", "/transfer.html", "/admin"]) {
    const response = await request(page, { headers: { cookie } });
    assert.equal(response.status, 200, page);
    assertThemeLoadsFirst(await response.text(), page);
  }
});
