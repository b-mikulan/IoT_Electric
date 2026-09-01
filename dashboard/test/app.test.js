const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createApp } = require("../app");

class FakePoller extends EventEmitter {
  constructor() {
    super();
    this.writeCalls = [];
    this.discoveryCalls = [];
    this.addedWidgets = [];
    this.updatedWidgets = [];
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
  assert.match(page, /dashboard\/config\/widgets\.json/);
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
