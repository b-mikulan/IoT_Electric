const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createApp } = require("../app");

class FakePoller extends EventEmitter {
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
        },
      ],
    };
  }
}

async function startApp(t) {
  const poller = new FakePoller();
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
      },
    ],
  };
  const app = createApp({ poller, config });
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
  assert.equal(materializeResponse.status, 200);
  assert.match(materializeResponse.headers.get("content-type"), /text\/css/);
  assert.equal(stylesResponse.status, 200);
  assert.match(await stylesResponse.text(), /background-color: var\(--surface\)/);

  const publicConfig = await configResponse.json();
  assert.equal(publicConfig.widgets[0].id, "point-1");
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

  poller.emit("update", {
    syncedAt: "2026-08-20T08:15:15.000Z",
    widgets: [{ id: "point-1", value: 22.8, state: 0, error: null }],
  });
  const updateChunk = await reader.read();
  const updateText = new TextDecoder().decode(updateChunk.value);

  assert.match(updateText, /event: update/);
  assert.match(updateText, /"value":22.8/);
  await reader.cancel();
  assert.equal(poller.listenerCount("update"), 1);
});
