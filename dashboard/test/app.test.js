const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app");
const { createRuntime } = require("../server");
const { PointPoller } = require("../lib/pointPoller");
const { WidgetStore } = require("../lib/widgetStore");
const { loadConfig } = require("../lib/config");

class FakePoller extends EventEmitter {
  constructor() {
    super();
    this.writeCalls = [];
    this.discoveryCalls = [];
    this.addedWidgets = [];
    this.updatedWidgets = [];
    this.removedWidgets = [];
  }

  getSnapshot() {
    return {
      status: "connected",
      syncedAt: "2026-08-20T08:15:00.000Z",
      error: null,
      widgets: [
        {
          id: "point-1",
          label: "Temperatura",
          unit: "°C",
          value: 22.4,
          state: 0,
          error: null,
          updatedAt: "2026-08-20T08:00:00.000Z",
        },
      ],
    };
  }

  async writeValue(id, value) {
    this.writeCalls.push({ id, value });
    return { id, success: true, message: "accepted" };
  }

  async discoverObjects(query) {
    this.discoveryCalls.push(query);
    return {
      containerId: query,
      exactMatch: false,
      truncated: false,
      errors: [],
      items: [
        {
          id: "building/temperature",
          kind: "value",
          name: "Nova temperatura",
          description: "Ured",
          type: "AnalogValue",
          unit: "°C",
          controllerWritable: true,
          alreadyAdded: false,
        },
      ],
    };
  }

  addWidget(widget) {
    const added = { ...widget, writable: false };
    this.addedWidgets.push(added);
    this.emit("config", { widget: added });
    return added;
  }

  updateWidget(id, widget) {
    const updated = { ...widget, id };
    this.updatedWidgets.push(updated);
    this.emit("config", { widget: updated });
    return updated;
  }

  removeWidget(id) {
    this.removedWidgets.push(id);
    this.emit("removed", { id });
    return { id };
  }
}

async function startApp(
  t,
  { writable = false, visible = true, widgetStoreEnabled = false } = {}
) {
  const poller = new FakePoller();
  const widgetStore = {
    enabled: widgetStoreEnabled,
    added: [],
    visibilityUpdates: [],
    settingsUpdates: [],
    removed: [],
    async add(widget) {
      this.added.push(widget);
      return { ...widget };
    },
    async setVisibility(id, nextVisible) {
      this.visibilityUpdates.push({ id, visible: nextVisible });
      return { id, visible: nextVisible };
    },
    async updateSettings(id, settings) {
      this.settingsUpdates.push({ id, settings });
      return { ...settings, id };
    },
    async remove(id) {
      this.removed.push(id);
      return { id };
    },
  };
  const config = {
    demoMode: false,
    intervalMs: 15_000,
    middlewareUrl: "http://middleware:3000",
    username: "dashboard-user",
    password: "never-return-this",
    widgets: [
      {
        id: "point-1",
        label: "Temperatura",
        description: "Ured",
        unit: "°C",
        precision: 1,
        writable,
        visible,
      },
    ],
  };
  const app = createApp({ poller, config, widgetStore });
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => {
      resolve(listeningServer);
    });
  });

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      })
  );

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    poller,
    widgetStore,
  };
}

test("serves the dashboard and exposes only public configuration", async (t) => {
  const { baseUrl } = await startApp(t);

  const [
    pageResponse,
    materializeResponse,
    stylesResponse,
    configResponse,
    healthResponse,
    readyResponse,
  ] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/vendor/materialize/materialize.min.css`),
      fetch(`${baseUrl}/styles.css`),
      fetch(`${baseUrl}/api/config`),
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/ready`),
    ]);

  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /<html lang="hr" theme="light">/);
  assert.match(page, /PLC vrijednosti uživo/);
  assert.match(page, /<details class="control-disclosure">/);
  assert.match(page, /<summary class="control-summary">/);
  assert.match(page, /Čekam prvu uspješnu provjeru servera/);
  assert.match(page, /Promjena: —/);
  assert.match(page, /Osvježavanje podataka nije uspjelo/);
  assert.equal(materializeResponse.status, 200);
  assert.match(materializeResponse.headers.get("content-type"), /text\/css/);
  assert.equal(stylesResponse.status, 200);
  const styles = await stylesResponse.text();
  assert.match(styles, /background-color: var\(--surface\)/);
  assert.match(styles, /\[hidden\]\s*{\s*display:\s*none\s*!important/);
  assert.match(styles, /\.widget-value\.is-text/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);

  const publicConfig = await configResponse.json();
  assert.equal(publicConfig.widgets[0].id, "point-1");
  assert.equal(publicConfig.widgets[0].writable, false);
  assert.equal(publicConfig.widgets[0].visible, true);
  assert.equal(publicConfig.discoveryEnabled, true);
  assert.equal(publicConfig.widgetEditingEnabled, false);
  assert.equal(Object.hasOwn(publicConfig, "middlewareUrl"), false);
  assert.equal(Object.hasOwn(publicConfig, "username"), false);
  assert.equal(Object.hasOwn(publicConfig, "password"), false);
  assert.equal(JSON.stringify(publicConfig).includes("never-return-this"), false);

  const health = await healthResponse.json();
  assert.deepEqual(health, {
    status: "ok",
    source: "connected",
    lastSync: "2026-08-20T08:15:00.000Z",
  });

  assert.equal(readyResponse.status, 200);
  assert.equal((await readyResponse.json()).status, "ready");
});

test("persists widget visibility without deleting its configuration", async (t) => {
  const { baseUrl, widgetStore } = await startApp(t, {
    widgetStoreEnabled: true,
  });

  const response = await fetch(`${baseUrl}/api/widgets/visibility`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "point-1", visible: false }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "point-1", visible: false });
  assert.deepEqual(widgetStore.visibilityUpdates, [
    { id: "point-1", visible: false },
  ]);

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.equal((await configResponse.json()).widgets[0].visible, false);

  const invalidResponse = await fetch(`${baseUrl}/api/widgets/visibility`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "point-1", visible: "false" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(
    (await invalidResponse.json()).code,
    "INVALID_VISIBILITY_BODY"
  );
});

test("updates editable widget settings while keeping the controller id", async (t) => {
  const { baseUrl, poller, widgetStore } = await startApp(t, {
    widgetStoreEnabled: true,
  });
  const settings = {
    id: "point-1",
    label: "Sobna temperatura",
    description: "Prizemlje",
    unit: "°C",
    precision: 2,
    writable: true,
    visible: false,
  };

  const response = await fetch(`${baseUrl}/api/widgets/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).widget, settings);
  assert.deepEqual(widgetStore.settingsUpdates, [
    { id: "point-1", settings },
  ]);
  assert.deepEqual(poller.updatedWidgets, [settings]);

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.deepEqual((await configResponse.json()).widgets[0], settings);

  const invalidResponse = await fetch(`${baseUrl}/api/widgets/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...settings, precision: 8 }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(
    (await invalidResponse.json()).code,
    "INVALID_WIDGET_SETTINGS"
  );
});

test("discovers a value before persisting it as a read-only widget", async (t) => {
  const { baseUrl, poller, widgetStore } = await startApp(t, {
    widgetStoreEnabled: true,
  });

  const searchResponse = await fetch(`${baseUrl}/api/discovery/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "building" }),
  });
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.canAdd, true);
  assert.equal(search.items[0].id, "building/temperature");
  assert.deepEqual(poller.discoveryCalls, ["building"]);

  const addResponse = await fetch(`${baseUrl}/api/widgets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "building/temperature" }),
  });
  assert.equal(addResponse.status, 201);
  const added = await addResponse.json();
  assert.equal(added.widget.id, "building/temperature");
  assert.equal(added.widget.writable, false);
  assert.equal(widgetStore.added[0].label, "Nova temperatura");
  assert.equal(poller.addedWidgets[0].writable, false);

  const unsafelySkippedSearch = await fetch(`${baseUrl}/api/widgets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "not-discovered" }),
  });
  assert.equal(unsafelySkippedSearch.status, 409);
  assert.equal(
    (await unsafelySkippedSearch.json()).code,
    "DISCOVERY_REQUIRED"
  );
});

test("forwards scalar writes without exposing middleware credentials", async (t) => {
  const { baseUrl, poller } = await startApp(t, { writable: true });
  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.equal((await configResponse.json()).widgets[0].writable, true);

  const response = await fetch(`${baseUrl}/api/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ widgetId: "point-1", value: 23.5 }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "point-1",
    success: true,
    message: "accepted",
  });
  assert.deepEqual(poller.writeCalls, [{ id: "point-1", value: 23.5 }]);

  const stringResponse = await fetch(`${baseUrl}/api/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ widgetId: "point-1", value: "Hello World" }),
  });
  assert.equal(stringResponse.status, 200);
  assert.deepEqual(poller.writeCalls.at(-1), {
    id: "point-1",
    value: "Hello World",
  });

  const invalidResponse = await fetch(`${baseUrl}/api/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: 23.5 }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).code, "INVALID_WRITE_BODY");
  assert.equal(poller.writeCalls.length, 2);
});

test("starts an SSE stream with the current snapshot", async (t) => {
  const { baseUrl, poller } = await startApp(t);
  const response = await fetch(`${baseUrl}/events`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  const text = new TextDecoder().decode(firstChunk.value);

  assert.match(text, /event: snapshot/);
  assert.match(text, /"id":"point-1"/);
  assert.match(text, /"updatedAt":"2026-08-20T08:00:00.000Z"/);

  poller.emit("update", {
    syncedAt: "2026-08-20T08:15:15.000Z",
    widgets: [
      {
        id: "point-1",
        value: 22.8,
        state: 0,
        error: null,
        updatedAt: "2026-08-20T08:15:15.000Z",
      },
    ],
  });
  const updateChunk = await reader.read();
  const updateText = new TextDecoder().decode(updateChunk.value);

  assert.match(updateText, /event: update/);
  assert.match(updateText, /"value":22.8/);
  assert.match(updateText, /"updatedAt":"2026-08-20T08:15:15.000Z"/);
  await reader.cancel();
  assert.equal(poller.listenerCount("update"), 1);
});

test("deletes a widget, rejects invalid requests and retains configuration when saving fails", async (t) => {
  const { baseUrl, poller, widgetStore } = await startApp(t, { widgetStoreEnabled: true, writable: true });
  const remove = (body) => fetch(`${baseUrl}/api/widgets`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await remove({ id: "missing" })).status, 404);
  assert.equal((await remove({ id: "" })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/widgets`, { method: "DELETE" })).status, 415);
  const originalRemove = widgetStore.remove;
  widgetStore.remove = async () => { throw new Error("disk failure"); };
  assert.equal((await remove({ id: "point-1" })).status, 500);
  assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).widgets.length, 1);
  assert.deepEqual(poller.removedWidgets, []);
  widgetStore.remove = originalRemove;
  const response = await remove({ id: "point-1" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "point-1" });
  assert.deepEqual(widgetStore.removed, ["point-1"]);
  assert.deepEqual(poller.removedWidgets, ["point-1"]);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/config`)).json()).widgets, []);
  assert.equal((await remove({ id: "point-1" })).status, 404);
  const readOnly = await startApp(t);
  assert.equal((await fetch(`${readOnly.baseUrl}/api/widgets`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "point-1" }) })).status, 409);
});

test("last-widget deletion persists across restart and broadcasts removal to open clients", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-delete-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const widgetFile = path.join(directory, "widgets.json");
  await fs.writeFile(widgetFile, JSON.stringify([{ id: "last", label: "Last", writable: true }]));
  const env = { DEMO_MODE: "false", MIDDLEWARE_USER: "client", MIDDLEWARE_PASSWORD: "secret", WIDGETS_FILE: widgetFile };
  const config = loadConfig(env);
  const poller = new PointPoller({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({ values: [{ id: "last", value: 1 }] }) }) });
  await poller.poll();
  const app = createApp({ poller, config, widgetStore: new WidgetStore(widgetFile) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const readers = await Promise.all([1, 2].map(async () => {
    const response = await fetch(`${baseUrl}/events`, { signal: AbortSignal.timeout(4000) });
    const reader = response.body.getReader();
    await reader.read();
    return reader;
  }));
  const deletion = await fetch(`${baseUrl}/api/widgets`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "last" }) });
  assert.equal(deletion.status, 200);
  for (const reader of readers) {
    let events = "";
    while (!events.includes("event: removed")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      events += new TextDecoder().decode(chunk.value);
    }
    assert.match(events, /"id":"last"/);
    await reader.cancel();
  }
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), []);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/snapshot`)).json()).widgets, []);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
  const writeResponse = await fetch(`${baseUrl}/api/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ widgetId: "last", value: 42 }) });
  assert.equal(writeResponse.status, 403);
  const restarted = createRuntime(env);
  assert.deepEqual(restarted.config.widgets, []);
  assert.equal((await restarted.poller.poll()).status, "idle");
  assert.equal(restarted.widgetStore.enabled, true);
});

test("automatic discovery runs in the background, broadcasts additions, keeps existing settings and returns a tree", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-auto-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const widgetFile = path.join(directory, "widgets.json");
  const existing = { id: "existing", label: "Custom name", precision: 2, visible: false, writable: true };
  await fs.writeFile(widgetFile, JSON.stringify([existing]));
  const config = loadConfig({ DEMO_MODE: "false", MIDDLEWARE_USER: "client", MIDDLEWARE_PASSWORD: "secret", WIDGETS_FILE: widgetFile });
  let releaseRoot;
  const rootGate = new Promise((resolve) => { releaseRoot = resolve; });
  let failBranch = false;
  const poller = new PointPoller({ ...config, fetchImpl: async (url) => {
    if (String(url).includes("/api/values/read")) return { ok: true, json: async () => ({ values: [] }) };
    const id = new URL(url).searchParams.get("id");
    await rootGate;
    return { ok: true, json: async () => id === ""
      ? { containers: [{ containerItems: [{ id: "floor", name: "Floor" }], valueItems: [{ id: "existing", name: "EWS name" }] }] }
      : failBranch ? { containers: [], errors: [{ id, message: "Cannot read" }] }
      : { containers: [{ valueItems: [{ id: "floor/temperature", name: "Temperature", unit: "°C", writeable: 1 }] }] } };
  } });
  const store = new WidgetStore(widgetFile);
  const server = createApp({ poller, config, widgetStore: store }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = () => fetch(`${baseUrl}/api/discovery/auto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  async function completed() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await (await fetch(`${baseUrl}/api/discovery/auto`)).json();
      if (state.state !== "running") return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Automatic discovery did not finish");
  }
  assert.equal((await fetch(`${baseUrl}/api/discovery/auto`, { method: "POST" })).status, 415);
  const events = await fetch(`${baseUrl}/events`, { signal: AbortSignal.timeout(4000) });
  const reader = events.body.getReader();
  await reader.read();
  assert.equal((await start()).status, 202);
  assert.equal((await start()).status, 409);
  releaseRoot();
  const result = await completed();
  assert.equal(result.state, "done");
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.containers, 2);
  assert.equal(result.tree.find((item) => item.id === "floor/temperature").parentId, "floor");
  let stream = "";
  while (!stream.includes("event: config")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    stream += new TextDecoder().decode(chunk.value);
  }
  assert.match(stream, /"widgets":\[\{"id":"floor\/temperature"/);
  await reader.cancel();
  const saved = JSON.parse(await fs.readFile(widgetFile, "utf8"));
  assert.deepEqual(saved[0], existing);
  assert.equal(saved.length, 2);
  assert.equal(poller.getSnapshot().widgets[1].writable, false);
  assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).autoDiscovery.state, "done");
  assert.equal((await start()).status, 202);
  assert.equal((await completed()).added, 0);
  failBranch = true;
  assert.equal((await start()).status, 202);
  assert.equal((await completed()).state, "error");
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), saved);
  failBranch = false;
  store.addMany = async () => { throw new Error("disk error"); };
  assert.equal((await start()).status, 202);
  assert.equal((await completed()).state, "error");
  assert.equal(poller.getSnapshot().widgets.length, 2);
  const readOnly = await startApp(t);
  assert.equal((await fetch(`${readOnly.baseUrl}/api/discovery/auto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 409);
});
