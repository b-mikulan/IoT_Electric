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

  removeAllWidgets() {
    const ids = this.getSnapshot().widgets.map((widget) => widget.id).filter((id) => !this.removedWidgets.includes(id));
    this.removedWidgets.push(...ids);
    this.emit("removed", { ids });
    return { ids };
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
    clearCalls: 0,
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
    async clear() {
      this.clearCalls += 1;
      return { ids: [] };
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
    config,
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
  assert.deepEqual((await response.json()).widget, { ...settings, group: "PLC vrijednosti" });
  assert.deepEqual(widgetStore.settingsUpdates, [
    { id: "point-1", settings },
  ]);
  assert.deepEqual(poller.updatedWidgets, [settings]);

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.deepEqual((await configResponse.json()).widgets[0], { ...settings, group: "PLC vrijednosti" });

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

test("bulk deletion keeps widgets when saving fails and blocks overlapping automatic discovery", async (t) => {
  const { baseUrl, poller, widgetStore, config } = await startApp(t, { widgetStoreEnabled: true });
  const clear = () => fetch(`${baseUrl}/api/widgets/all`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await fetch(`${baseUrl}/api/widgets/all`, { method: "DELETE" })).status, 415);
  widgetStore.clear = async () => { throw new Error("disk failure"); };
  assert.equal((await clear()).status, 500);
  assert.equal(config.widgets.length, 1);
  assert.deepEqual(poller.removedWidgets, []);
  let finishClear;
  widgetStore.clear = () => new Promise((resolve) => { finishClear = resolve; });
  const pending = clear();
  while (!finishClear) await new Promise((resolve) => setImmediate(resolve));
  const discovery = await fetch(`${baseUrl}/api/discovery/auto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(discovery.status, 409);
  assert.equal((await discovery.json()).code, "WIDGET_CLEAR_IN_PROGRESS");
  assert.equal((await clear()).status, 409);
  finishClear({ ids: ["point-1"] });
  assert.equal((await pending).status, 200);
  assert.deepEqual(config.widgets, []);
  const readOnly = await startApp(t);
  assert.equal((await fetch(`${readOnly.baseUrl}/api/widgets/all`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 409);
  const demo = await startApp(t, { widgetStoreEnabled: true });
  demo.config.demoMode = true;
  assert.equal((await fetch(`${demo.baseUrl}/api/widgets/all`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 409);
});

async function startPersistedDashboard(t, widgets) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-bulk-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const widgetFile = path.join(directory, "widgets.json");
  await fs.writeFile(widgetFile, JSON.stringify(widgets));
  const env = { DEMO_MODE: "false", MIDDLEWARE_USER: "client", MIDDLEWARE_PASSWORD: "secret", WIDGETS_FILE: widgetFile };
  const config = loadConfig(env);
  const poller = new PointPoller({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({ values: widgets.map(({ id }) => ({ id, value: 42 })) }) }) });
  await poller.poll();
  const store = new WidgetStore(widgetFile);
  const server = createApp({ poller, config, widgetStore: store }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, widgetFile, env, poller, config, store };
}

test("bulk removal persists an empty dashboard across restart and updates every SSE client", async (t) => {
  const { baseUrl, widgetFile, env, poller } = await startPersistedDashboard(t, [{ id: "floor/one", writable: true }, { id: "floor/two", visible: false }]);
  const readers = await Promise.all([1, 2].map(async () => {
    const response = await fetch(`${baseUrl}/events`, { signal: AbortSignal.timeout(4_000) });
    const reader = response.body.getReader();
    await reader.read();
    return reader;
  }));
  const clear = () => fetch(`${baseUrl}/api/widgets/all`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  const response = await clear();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ids: ["floor/one", "floor/two"] });
  for (const reader of readers) {
    let events = "";
    while (!events.includes("event: removed")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      events += new TextDecoder().decode(chunk.value);
    }
    assert.match(events, /"ids":\["floor\/one","floor\/two"\]/);
    await reader.cancel();
  }
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), []);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/config`)).json()).widgets, []);
  assert.deepEqual(poller.getSnapshot(), { status: "idle", syncedAt: null, error: null, widgets: [] });
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
  await assert.rejects(poller.writeValue("floor/one", 42), { code: "POINT_NOT_WRITABLE" });
  assert.deepEqual(await (await clear()).json(), { ids: [] });
  assert.deepEqual(createRuntime(env).config.widgets, []);
});

test("widget settings round-trip custom groups, preserve old clients and restore automatic grouping", async (t) => {
  const { baseUrl, widgetFile, env, poller } = await startPersistedDashboard(t, [{ id: "floor/one", group: "Ured" }]);
  const settings = { id: "floor/one", label: "One", description: "Office", unit: "°C", precision: 1, writable: false, visible: true };
  const update = (group = {}) => fetch(`${baseUrl}/api/widgets/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, ...group }) });
  assert.equal((await (await update()).json()).widget.group, "Ured");
  assert.equal((await (await update({ group: "  Prizemlje  " })).json()).widget.group, "Prizemlje");
  assert.equal(poller.getSnapshot().widgets[0].group, "Prizemlje");
  assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).widgets[0].group, "Prizemlje");
  assert.equal(createRuntime(env).config.widgets[0].group, "Prizemlje");
  for (const group of [null, 1, "x".repeat(1_025)]) assert.equal((await update({ group })).status, 400);
  assert.equal((await (await update({ group: " " })).json()).widget.group, "floor");
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(widgetFile, "utf8"))[0], "group"), false);
  assert.equal(createRuntime(env).config.widgets[0].group, "floor");
});

test("group removal deletes hidden members, preserves equal labels in other groups and broadcasts the selected IDs", async (t) => {
  const kept = { id: "other/one", label: "Temperature", group: "Other", custom: { retained: true }, visible: false, writable: true, precision: 3 };
  const widgets = [{ id: "floor/one", label: "Temperature", group: "  Floor  ", visible: false }, kept, { id: "floor/two", label: "Humidity" }];
  const { baseUrl, widgetFile, env, poller } = await startPersistedDashboard(t, widgets);
  const events = await fetch(`${baseUrl}/events`, { signal: AbortSignal.timeout(4_000) });
  const reader = events.body.getReader();
  await reader.read();
  const remove = (group) => fetch(`${baseUrl}/api/widgets/group`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group }) });
  const response = await remove("  Floor  ");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ids: ["floor/one"] });
  let stream = "";
  while (!stream.includes("event: removed")) stream += new TextDecoder().decode((await reader.read()).value);
  assert.match(stream, /"ids":\["floor\/one"\]/);
  await reader.cancel();
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), [kept, widgets[2]]);
  assert.deepEqual(poller.getSnapshot().widgets.map(({ id }) => id), [kept.id, "floor/two"]);
  assert.deepEqual(createRuntime(env).config.widgets.map(({ id }) => id), [kept.id, "floor/two"]);
  // The automatic parent-folder group remains independent of a custom group with a different case.
  const automatic = await remove(" floor ");
  assert.deepEqual(await automatic.json(), { ids: ["floor/two"] });
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), [kept]);
});

test("group removal validates names, retains configuration on file failure and locks other bulk operations", async (t) => {
  const original = [{ id: "floor/one", visible: false }, { id: "other/one" }];
  const { baseUrl, widgetFile, poller, config, store } = await startPersistedDashboard(t, original);
  const remove = (group) => fetch(`${baseUrl}/api/widgets/group`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group }) });
  for (const group of ["", " ", null, 1, "x".repeat(1_025)]) assert.equal((await remove(group)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/widgets/group`, { method: "DELETE" })).status, 415);
  const missing = await remove("missing");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "WIDGET_GROUP_NOT_FOUND");
  const realRemove = store.removeMany.bind(store);
  store.removeMany = async () => { throw new Error("disk failure"); };
  assert.equal((await remove("floor")).status, 500);
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), original);
  assert.equal(config.widgets.length, 2);
  assert.equal(poller.getSnapshot().widgets.length, 2);
  let finishRemoval;
  store.removeMany = (ids) => new Promise((resolve) => { finishRemoval = async () => resolve(await realRemove(ids)); });
  const pending = remove("floor");
  while (!finishRemoval) await new Promise((resolve) => setImmediate(resolve));
  for (const endpoint of ["/api/widgets/all", "/api/widgets/group"]) {
    const blocked = await fetch(`${baseUrl}${endpoint}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "other" }) });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "WIDGET_CLEAR_IN_PROGRESS");
  }
  const discovery = await fetch(`${baseUrl}/api/discovery/auto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(discovery.status, 409);
  await finishRemoval();
  assert.equal((await pending).status, 200);
  const readOnly = await startApp(t);
  assert.equal((await fetch(`${readOnly.baseUrl}/api/widgets/group`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "PLC vrijednosti" }) })).status, 409);
  const demo = await startApp(t, { widgetStoreEnabled: true });
  demo.config.demoMode = true;
  assert.equal((await fetch(`${demo.baseUrl}/api/widgets/group`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "PLC vrijednosti" }) })).status, 409);
});

test("group renaming includes hidden/default/custom members, persists settings and sends one batched SSE update", async (t) => {
  const kept = { id: "other/value", label: "Temperature", custom: { retain: true }, writable: true };
  const widgets = [{ id: "floor/one", label: "Temperature", writable: true, precision: 3, custom: true }, { id: "floor/two", visible: false }, { id: "opaque", group: "floor", visible: false }, kept];
  const { baseUrl, widgetFile, env, poller } = await startPersistedDashboard(t, widgets);
  const before = poller.getSnapshot();
  const configEvents = [];
  poller.on("config", (event) => configEvents.push(event));
  const readers = await Promise.all([1, 2].map(async () => {
    const response = await fetch(`${baseUrl}/events`, { signal: AbortSignal.timeout(4_000) });
    const reader = response.body.getReader();
    await reader.read();
    return reader;
  }));
  const response = await fetch(`${baseUrl}/api/widgets/group`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: " floor ", name: " Prizemlje " }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.group, "floor");
  assert.equal(result.name, "Prizemlje");
  assert.deepEqual(result.widgets.map(({ id, group }) => ({ id, group })), widgets.slice(0, 3).map(({ id }) => ({ id, group: "Prizemlje" })));
  assert.equal(configEvents.length, 1);
  assert.equal(configEvents[0].widgets.length, 3);
  assert.deepEqual(configEvents[0].groupRename, { from: "floor", to: "Prizemlje" });
  for (const reader of readers) {
    let stream = "";
    while (!stream.includes("event: config")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      stream += new TextDecoder().decode(chunk.value);
    }
    assert.match(stream, /"group":"Prizemlje"/);
    assert.match(stream, /"id":"opaque"/);
    assert.match(stream, /"groupRename":\{"from":"floor","to":"Prizemlje"\}/);
    assert.equal(stream.match(/event: config/g).length, 1);
    await reader.cancel();
  }
  assert.deepEqual(poller.getSnapshot(), { ...before, widgets: before.widgets.map((widget, index) => index < 3 ? { ...widget, group: "Prizemlje" } : widget) });
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), widgets.map((widget, index) => index < 3 ? { ...widget, group: "Prizemlje" } : widget));
  assert.deepEqual(createRuntime(env).config.widgets.map(({ group }) => group), ["Prizemlje", "Prizemlje", "Prizemlje", "other"]);
  assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).widgets[1].visible, false);
});

test("group renaming rejects conflicts and bad names, is idempotent and keeps file/runtime state on failure", async (t) => {
  const { baseUrl, widgetFile, poller, config, store } = await startPersistedDashboard(t, [{ id: "floor/one", visible: false }, { id: "other/value", group: "Custom" }]);
  const rename = (body) => fetch(`${baseUrl}/api/widgets/group`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const before = await fs.readFile(widgetFile, "utf8");
  const snapshot = poller.getSnapshot();
  const events = [];
  poller.on("config", (event) => events.push(event));
  assert.equal((await fetch(`${baseUrl}/api/widgets/group`, { method: "PATCH" })).status, 415);
  for (const invalid of ["", " ", null, 1, "x".repeat(1_025)]) {
    assert.equal((await rename({ group: invalid, name: "New" })).status, 400);
    assert.equal((await rename({ group: "floor", name: invalid })).status, 400);
  }
  assert.equal((await rename({ group: "floor" })).status, 400);
  const conflict = await rename({ group: "floor", name: " Custom " });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "WIDGET_GROUP_EXISTS");
  const missing = await rename({ group: "missing", name: "New" });
  assert.equal(missing.status, 404);
  const unchanged = await rename({ group: " floor ", name: "floor" });
  assert.equal(unchanged.status, 200);
  assert.equal((await unchanged.json()).widgets.length, 1);
  assert.equal(events.length, 0);
  store.renameGroup = async () => { throw new Error("disk failure"); };
  const failed = await rename({ group: "floor", name: "New" });
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).code, "WIDGET_GROUP_RENAME_FAILED");
  assert.equal(await fs.readFile(widgetFile, "utf8"), before);
  assert.deepEqual(poller.getSnapshot(), snapshot);
  assert.equal(config.widgets[0].group, "floor");
  assert.equal(events.length, 0);
  for (const demoMode of [false, true]) {
    const unavailable = await startApp(t, { widgetStoreEnabled: demoMode });
    unavailable.config.demoMode = demoMode;
    const response = await fetch(`${unavailable.baseUrl}/api/widgets/group`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "PLC vrijednosti", name: "New" }) });
    assert.equal(response.status, 409);
  }
});

test("group renaming shares the bulk lock with deletions and automatic discovery", async (t) => {
  const { baseUrl, store } = await startPersistedDashboard(t, [{ id: "floor/one" }, { id: "other/value" }]);
  const realRename = store.renameGroup.bind(store);
  let finishRename;
  store.renameGroup = (group, name) => new Promise((resolve) => { finishRename = async () => resolve(await realRename(group, name)); });
  const rename = (group, name) => fetch(`${baseUrl}/api/widgets/group`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group, name }) });
  const pending = rename("floor", "Renamed");
  while (!finishRename) await new Promise((resolve) => setImmediate(resolve));
  const concurrentRename = await rename("other", "Other");
  assert.equal(concurrentRename.status, 409);
  assert.equal((await concurrentRename.json()).code, "WIDGET_CLEAR_IN_PROGRESS");
  for (const endpoint of ["/api/widgets/all", "/api/widgets/group"]) {
    const response = await fetch(`${baseUrl}${endpoint}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "other" }) });
    assert.equal(response.status, 409);
  }
  const discovery = await fetch(`${baseUrl}/api/discovery/auto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(discovery.status, 409);
  await finishRename();
  assert.equal((await pending).status, 200);
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
      ? { containers: [{ containerItems: [{ id: "floor", name: "Floor" }, ...(failBranch ? [{ id: "other", name: "Other" }] : [])], valueItems: [{ id: "existing", name: "EWS name" }] }] }
      : failBranch && id === "floor" ? { containers: [], errors: [{ id, message: "Cannot read" }] }
      : { containers: [{ valueItems: [{ id: `${id}/temperature`, name: "Temperature", unit: "°C", writeable: 1 }] }] } };
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
  const clearWhileScanning = await fetch(`${baseUrl}/api/widgets/all`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(clearWhileScanning.status, 409);
  assert.equal((await clearWhileScanning.json()).code, "DISCOVERY_IN_PROGRESS");
  const removeGroupWhileScanning = await fetch(`${baseUrl}/api/widgets/group`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "PLC vrijednosti" }) });
  assert.equal(removeGroupWhileScanning.status, 409);
  assert.equal((await removeGroupWhileScanning.json()).code, "DISCOVERY_IN_PROGRESS");
  const renameWhileScanning = await fetch(`${baseUrl}/api/widgets/group`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: "PLC vrijednosti", name: "Renamed" }) });
  assert.equal(renameWhileScanning.status, 409);
  assert.equal((await renameWhileScanning.json()).code, "DISCOVERY_IN_PROGRESS");
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), [existing]);
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
  const partial = await completed();
  assert.equal(partial.state, "done");
  assert.equal(partial.added, 1);
  assert.equal(partial.failedBranches, 1);
  assert.deepEqual(partial.warnings, [{ id: "floor", message: "Cannot read" }]);
  assert.equal(partial.tree.find((node) => node.id === "floor").error, "Cannot read");
  const partialSaved = JSON.parse(await fs.readFile(widgetFile, "utf8"));
  assert.deepEqual(partialSaved.slice(0, 2), saved);
  assert.equal(partialSaved[2].id, "other/temperature");
  assert.equal(poller.getSnapshot().widgets.length, 3);
  failBranch = false;
  store.addMany = async () => { throw new Error("disk error"); };
  assert.equal((await start()).status, 202);
  assert.equal((await completed()).state, "error");
  assert.equal(poller.getSnapshot().widgets.length, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(widgetFile, "utf8")), partialSaved);
  const readOnly = await startApp(t);
  assert.equal((await fetch(`${readOnly.baseUrl}/api/discovery/auto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 409);
});
