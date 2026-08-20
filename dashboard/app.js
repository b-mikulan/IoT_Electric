const express = require("express");
const path = require("node:path");

const publicDirectory = path.join(__dirname, "public");
const materializeDirectory = path.dirname(
  require.resolve("@materializecss/materialize/dist/css/materialize.min.css")
);

function sendEvent(response, event, payload) {
  return response.write(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  );
}

function createApp({ poller, config }) {
  if (!poller) throw new Error("A point poller is required.");
  if (!config) throw new Error("Dashboard configuration is required.");

  const app = express();
  const eventClients = new Set();
  app.disable("x-powered-by");

  function broadcast(event, payload) {
    for (const response of eventClients) {
      try {
        if (!sendEvent(response, event, payload)) {
          eventClients.delete(response);
          response.end();
        }
      } catch (error) {
        eventClients.delete(response);
        response.end();
      }
    }
  }

  poller.on("update", (payload) => broadcast("update", payload));
  poller.on("status", (payload) => broadcast("status", payload));
  poller.on("sync", (payload) => broadcast("sync", payload));

  app.get("/health", (request, response) => {
    const snapshot = poller.getSnapshot();
    response.json({
      status: "ok",
      source: config.demoMode ? "demo" : snapshot.status || "starting",
      lastSync: snapshot.syncedAt || null,
    });
  });

  app.get("/ready", (request, response) => {
    const snapshot = poller.getSnapshot();
    const ready = snapshot.status === "connected";

    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not-ready",
      source: snapshot.status,
      lastSync: snapshot.syncedAt || null,
      error: snapshot.error || null,
    });
  });

  app.get("/api/config", (request, response) => {
    response.json({
      title: "IoT Electric · PLC pregled",
      demoMode: config.demoMode,
      intervalMs: config.intervalMs,
      widgets: config.widgets.map(
        ({ id, label, description, unit, precision }) => ({
          id,
          label,
          description,
          unit,
          ...(precision === undefined ? {} : { precision }),
        })
      ),
    });
  });

  app.get("/api/snapshot", (request, response) => {
    response.json(poller.getSnapshot());
  });

  app.get("/events", (request, response) => {
    response.status(200);
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();

    sendEvent(response, "snapshot", poller.getSnapshot());
    eventClients.add(response);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 25_000);

    request.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(response);
    });
  });

  app.use(
    "/vendor/materialize",
    express.static(materializeDirectory, {
      immutable: true,
      maxAge: "7d",
    })
  );
  app.use(express.static(publicDirectory));

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    return response.status(500).json({ error: "Dashboard request failed." });
  });

  return app;
}

module.exports = {
  createApp,
  sendEvent,
};
