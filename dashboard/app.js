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

function publicWidget(widget) {
  const { id, label, description, unit, precision, writable, visible } = widget;
  return {
    id,
    label,
    description,
    unit,
    ...(precision === undefined ? {} : { precision }),
    writable: writable === true,
    visible: visible !== false,
  };
}

function requireJson(request, response, next) {
  if (!request.is("application/json")) {
    return response.status(415).json({
      error: "Content-Type must be application/json.",
      code: "JSON_REQUIRED",
    });
  }
  return next();
}

function sendOperationError(response, error, fallbackCode, fallbackMessage) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return response.status(status).json({
    error: status >= 500 && !error?.code ? fallbackMessage : error.message,
    code: error?.code || fallbackCode,
  });
}

function parseWidgetSettings(body) {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : null;
  const unit = typeof body?.unit === "string" ? body.unit.trim() : null;
  const precision = body?.precision;

  if (
    !id ||
    !label ||
    label.length > 160 ||
    description === null ||
    description.length > 500 ||
    unit === null ||
    unit.length > 32 ||
    (precision !== null &&
      (!Number.isInteger(precision) || precision < 0 || precision > 6)) ||
    typeof body?.writable !== "boolean" ||
    typeof body?.visible !== "boolean"
  ) {
    return null;
  }

  return {
    id,
    label,
    description,
    unit,
    precision,
    writable: body.writable,
    visible: body.visible,
  };
}

function createApp({ poller, config, widgetStore = null }) {
  if (!poller) throw new Error("A point poller is required.");
  if (!config) throw new Error("Dashboard configuration is required.");

  const app = express();
  const eventClients = new Set();
  const discoveredById = new Map();
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
  poller.on("config", (payload) => broadcast("config", payload));

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
      discoveryEnabled: !config.demoMode,
      widgetEditingEnabled:
        !config.demoMode && Boolean(widgetStore?.enabled),
      widgets: config.widgets.map(publicWidget),
    });
  });

  app.get("/api/snapshot", (request, response) => {
    response.json(poller.getSnapshot());
  });

  app.post(
    "/api/write",
    requireJson,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      const body = request.body || {};
      const { widgetId, value } = body;
      if (typeof widgetId !== "string" || !Object.hasOwn(body, "value")) {
        return response.status(400).json({
          error: "Body must contain widgetId and value.",
          code: "INVALID_WRITE_BODY",
        });
      }

      try {
        const result = await poller.writeValue(widgetId, value);
        return response.json(result);
      } catch (error) {
        return sendOperationError(
          response,
          error,
          "DASHBOARD_WRITE_FAILED",
          "Dashboard write request failed."
        );
      }
    }
  );

  app.post(
    "/api/discovery/search",
    requireJson,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      const query = request.body?.query ?? "";
      if (typeof query !== "string") {
        return response.status(400).json({
          error: "query must be a string.",
          code: "INVALID_DISCOVERY_QUERY",
        });
      }

      try {
        const result = await poller.discoverObjects(query);
        discoveredById.clear();
        for (const item of result.items) {
          if (item.kind === "value") discoveredById.set(item.id, item);
        }
        return response.json({
          ...result,
          canAdd: Boolean(widgetStore?.enabled),
        });
      } catch (error) {
        return sendOperationError(
          response,
          error,
          "DISCOVERY_FAILED",
          "Dashboard discovery request failed."
        );
      }
    }
  );

  app.post(
    "/api/widgets",
    requireJson,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      const id =
        typeof request.body?.id === "string" ? request.body.id.trim() : "";
      if (!id) {
        return response.status(400).json({
          error: "id must be a non-empty string.",
          code: "INVALID_WIDGET_ID",
        });
      }
      if (!widgetStore?.enabled) {
        return response.status(409).json({
          error: "Widget saving requires a writable WIDGETS_FILE.",
          code: "WIDGET_FILE_UNAVAILABLE",
        });
      }

      const candidate = discoveredById.get(id);
      if (!candidate) {
        return response.status(409).json({
          error: "Search for this object again before adding it.",
          code: "DISCOVERY_REQUIRED",
        });
      }
      if (config.widgets.some((widget) => widget.id === id)) {
        return response.status(409).json({
          error: "This object is already on the dashboard.",
          code: "WIDGET_ALREADY_EXISTS",
        });
      }

      const widget = {
        id: candidate.id,
        label: candidate.name,
        description: candidate.description,
        unit: candidate.unit,
        writable: false,
      };

      try {
        const storedWidget = await widgetStore.add(widget);
        const runtimeWidget = poller.addWidget(storedWidget);
        config.widgets.push(runtimeWidget);
        discoveredById.set(id, { ...candidate, alreadyAdded: true });
        return response.status(201).json({ widget: publicWidget(runtimeWidget) });
      } catch (error) {
        return sendOperationError(
          response,
          error,
          "WIDGET_ADD_FAILED",
          "Dashboard could not add the widget."
        );
      }
    }
  );

  app.post(
    "/api/widgets/visibility",
    requireJson,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      const id =
        typeof request.body?.id === "string" ? request.body.id.trim() : "";
      const { visible } = request.body || {};
      if (!id || typeof visible !== "boolean") {
        return response.status(400).json({
          error: "Body must contain id and boolean visible.",
          code: "INVALID_VISIBILITY_BODY",
        });
      }
      if (!widgetStore?.enabled) {
        return response.status(409).json({
          error: "Widget visibility requires a writable WIDGETS_FILE.",
          code: "WIDGET_FILE_UNAVAILABLE",
        });
      }

      const widget = config.widgets.find((item) => item.id === id);
      if (!widget) {
        return response.status(404).json({
          error: "Widget was not found.",
          code: "WIDGET_NOT_FOUND",
        });
      }

      try {
        const result = await widgetStore.setVisibility(id, visible);
        widget.visible = result.visible;
        broadcast("visibility", result);
        return response.json(result);
      } catch (error) {
        return sendOperationError(
          response,
          error,
          "VISIBILITY_UPDATE_FAILED",
          "Dashboard could not update widget visibility."
        );
      }
    }
  );

  app.post(
    "/api/widgets/settings",
    requireJson,
    express.json({ limit: "8kb" }),
    async (request, response) => {
      const settings = parseWidgetSettings(request.body);
      if (!settings) {
        return response.status(400).json({
          error: "Widget settings are not valid.",
          code: "INVALID_WIDGET_SETTINGS",
        });
      }
      if (!widgetStore?.enabled) {
        return response.status(409).json({
          error: "Widget settings require a writable WIDGETS_FILE.",
          code: "WIDGET_FILE_UNAVAILABLE",
        });
      }

      const index = config.widgets.findIndex(
        (widget) => widget.id === settings.id
      );
      if (index < 0) {
        return response.status(404).json({
          error: "Widget was not found.",
          code: "WIDGET_NOT_FOUND",
        });
      }

      try {
        const storedWidget = await widgetStore.updateSettings(
          settings.id,
          settings
        );
        const runtimeWidget = poller.updateWidget(settings.id, storedWidget);
        config.widgets[index] = runtimeWidget;
        return response.json({ widget: publicWidget(runtimeWidget) });
      } catch (error) {
        return sendOperationError(
          response,
          error,
          "WIDGET_SETTINGS_UPDATE_FAILED",
          "Dashboard could not update widget settings."
        );
      }
    }
  );

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
    if (error?.type === "entity.parse.failed") {
      return response.status(400).json({
        error: "Request body is not valid JSON.",
        code: "INVALID_JSON",
      });
    }
    if (error?.type === "entity.too.large") {
      return response.status(413).json({
        error: "Request body is too large.",
        code: "BODY_TOO_LARGE",
      });
    }
    return response.status(500).json({ error: "Dashboard request failed." });
  });

  return app;
}

module.exports = {
  createApp,
  sendEvent,
};
