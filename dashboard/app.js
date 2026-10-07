const express = require("express");
const path = require("node:path");
const { TelemetryClient } = require("./lib/telemetry");
const { widgetGroup } = require("./lib/config");

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
    group: widgetGroup(widget),
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
  const hasGroup = Object.hasOwn(body || {}, "group");
  const group = typeof body?.group === "string" ? body.group.trim() : null;

  if (
    !id ||
    !label ||
    label.length > 160 ||
    description === null ||
    description.length > 500 ||
    unit === null ||
    unit.length > 32 ||
    (hasGroup && (group === null || group.length > 1_024)) ||
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
    ...(hasGroup ? { group } : {}),
    writable: body.writable,
    visible: body.visible,
  };
}

function createApp({ poller, config, widgetStore = null, telemetry = new TelemetryClient(config) }) {
  if (!poller) throw new Error("A point poller is required.");
  if (!config) throw new Error("Dashboard configuration is required.");

  const app = express();
  const eventClients = new Set();
  const discoveredById = new Map();
  let autoDiscovery = { state: "idle" };
  let clearingWidgets = false;
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
  function updateAutoDiscovery(update) {
    autoDiscovery = { ...autoDiscovery, ...update };
    broadcast("discovery", autoDiscovery);
  }

  async function runAutoDiscovery() {
    try {
      const { values, tree, warnings } = await poller.discoverAllValues({
        onProgress: (progress) => updateAutoDiscovery(progress),
      });
      updateAutoDiscovery({ phase: "saving", pending: 0, found: values.length });
      const stored = await widgetStore.addMany(values.map((item) => ({
        id: item.id, label: item.name, description: item.description, unit: item.unit,
      })));
      const added = poller.addWidgets(stored);
      config.widgets.push(...added);
      updateAutoDiscovery({ state: "done", added: added.length, skipped: values.length - added.length, tree, warnings });
    } catch (error) {
      updateAutoDiscovery({ state: "error", error: error?.code ? error.message : "Automatsko dodavanje nije uspjelo. Provjeri vezu i mogućnost spremanja widgeta." });
    }
  }
  poller.on("status", (payload) => broadcast("status", payload));
  poller.on("sync", (payload) => broadcast("sync", payload));
  poller.on("config", (payload) => broadcast("config", payload));
  poller.on("removed", (payload) => broadcast("removed", payload));

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
      autoDiscovery,
      widgets: config.widgets.map(publicWidget),
    });
  });

  app.get("/api/snapshot", (request, response) => {
    response.json(poller.getSnapshot());
  });

  for (const kind of ["history", "alarms"]) {
    app.post(`/api/${kind}/query`, requireJson, express.json({ limit: "16kb" }), async (request, response) => {
      try {
        return response.json(await telemetry.query(kind, request.body || {}));
      } catch (error) {
        return sendOperationError(response, error, "TELEMETRY_FAILED", "Dohvat podataka nije uspio.");
      }
    });
  }
  app.post("/api/history/browse", requireJson, express.json({ limit: "8kb" }), async (request, response) => {
    try {
      return response.json(await telemetry.browse(request.body?.containerId ?? ""));
    } catch (error) {
      return sendOperationError(response, error, "TELEMETRY_FAILED", "Dohvat trendova nije uspio.");
    }
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
        // Other widgets can be removed while this file update is pending.
        const currentIndex = config.widgets.findIndex((widget) => widget.id === settings.id);
        config.widgets[currentIndex] = runtimeWidget;
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

  app.get("/api/discovery/auto", (request, response) => response.json(autoDiscovery));
  app.post("/api/discovery/auto", requireJson, express.json({ limit: "4kb" }), (request, response) => {
    if (config.demoMode || !widgetStore?.enabled) {
      return response.status(409).json({ error: "Automatic discovery requires a writable WIDGETS_FILE and a live EWS connection.", code: "WIDGET_FILE_UNAVAILABLE" });
    }
    if (autoDiscovery.state === "running") {
      return response.status(409).json({ error: "Automatic discovery is already running.", code: "DISCOVERY_IN_PROGRESS" });
    }
    if (clearingWidgets) {
      return response.status(409).json({ error: "A bulk widget change is still in progress.", code: "WIDGET_CLEAR_IN_PROGRESS" });
    }
    autoDiscovery = { state: "running", phase: "scanning", containers: 0, pending: 1, found: 0, failedBranches: 0 };
    broadcast("discovery", autoDiscovery);
    // Long scans continue on the server after browser closure or proxy timeouts.
    void runAutoDiscovery();
    return response.status(202).json(autoDiscovery);
  });

  app.patch("/api/widgets/group", requireJson, express.json({ limit: "8kb" }), async (request, response) => {
    const group = typeof request.body?.group === "string" ? request.body.group.trim() : "";
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!group || !name || group.length > 1_024 || name.length > 1_024) {
      return response.status(400).json({ error: "group and name must be non-empty strings of at most 1024 characters.", code: "INVALID_WIDGET_GROUP" });
    }
    if (config.demoMode || !widgetStore?.enabled) {
      return response.status(409).json({ error: "Group renaming requires a writable WIDGETS_FILE.", code: "WIDGET_FILE_UNAVAILABLE" });
    }
    if (autoDiscovery.state === "running") {
      return response.status(409).json({ error: "Wait for automatic discovery to finish before renaming a group.", code: "DISCOVERY_IN_PROGRESS" });
    }
    if (clearingWidgets) {
      return response.status(409).json({ error: "A bulk widget change is already in progress.", code: "WIDGET_CLEAR_IN_PROGRESS" });
    }
    const members = config.widgets.filter((widget) => widgetGroup(widget) === group);
    if (members.length === 0) {
      return response.status(404).json({ error: "Widget group was not found.", code: "WIDGET_GROUP_NOT_FOUND" });
    }
    if (group === name) return response.json({ group, name, widgets: members.map(publicWidget) });
    if (config.widgets.some((widget) => widgetGroup(widget) === name)) {
      return response.status(409).json({ error: "A widget group with this name already exists.", code: "WIDGET_GROUP_EXISTS" });
    }
    clearingWidgets = true;
    try {
      const stored = await widgetStore.renameGroup(group, name);
      const updated = poller.updateWidgets(stored, { groupRename: { from: group, to: name } });
      const byId = new Map(updated.map((widget) => [widget.id, widget]));
      config.widgets = config.widgets.map((widget) => byId.get(widget.id) || widget);
      return response.json({ group, name, widgets: updated.map(publicWidget) });
    } catch (error) {
      return sendOperationError(response, error, "WIDGET_GROUP_RENAME_FAILED", "Dashboard could not rename the widget group.");
    } finally {
      clearingWidgets = false;
    }
  });

  app.delete("/api/widgets/group", requireJson, express.json({ limit: "4kb" }), async (request, response) => {
    const group = typeof request.body?.group === "string" ? request.body.group.trim() : "";
    if (!group || group.length > 1_024) {
      return response.status(400).json({ error: "group must be a non-empty string of at most 1024 characters.", code: "INVALID_WIDGET_GROUP" });
    }
    if (config.demoMode || !widgetStore?.enabled) {
      return response.status(409).json({ error: "Widget deletion requires a writable WIDGETS_FILE.", code: "WIDGET_FILE_UNAVAILABLE" });
    }
    if (autoDiscovery.state === "running") {
      return response.status(409).json({ error: "Wait for automatic discovery to finish before removing a group.", code: "DISCOVERY_IN_PROGRESS" });
    }
    if (clearingWidgets) {
      return response.status(409).json({ error: "A bulk widget change is already in progress.", code: "WIDGET_CLEAR_IN_PROGRESS" });
    }
    const ids = config.widgets.filter((widget) => widgetGroup(widget) === group).map((widget) => widget.id);
    if (ids.length === 0) {
      return response.status(404).json({ error: "Widget group was not found.", code: "WIDGET_GROUP_NOT_FOUND" });
    }
    clearingWidgets = true;
    try {
      await widgetStore.removeMany(ids);
      const removed = new Set(ids);
      config.widgets = config.widgets.filter((widget) => !removed.has(widget.id));
      for (const id of ids) discoveredById.delete(id);
      return response.json(poller.removeWidgets(ids));
    } catch (error) {
      return sendOperationError(response, error, "WIDGET_DELETE_FAILED", "Dashboard could not remove the widget group.");
    } finally {
      clearingWidgets = false;
    }
  });

  app.delete("/api/widgets/all", requireJson, express.json({ limit: "4kb" }), async (request, response) => {
    if (config.demoMode || !widgetStore?.enabled) {
      return response.status(409).json({ error: "Widget deletion requires a writable WIDGETS_FILE.", code: "WIDGET_FILE_UNAVAILABLE" });
    }
    if (autoDiscovery.state === "running") {
      return response.status(409).json({ error: "Wait for automatic discovery to finish before removing all widgets.", code: "DISCOVERY_IN_PROGRESS" });
    }
    if (clearingWidgets) {
      return response.status(409).json({ error: "A bulk widget change is already in progress.", code: "WIDGET_CLEAR_IN_PROGRESS" });
    }
    clearingWidgets = true;
    try {
      await widgetStore.clear();
      config.widgets = [];
      discoveredById.clear();
      return response.json(poller.removeAllWidgets());
    } catch (error) {
      return sendOperationError(response, error, "WIDGET_DELETE_FAILED", "Dashboard could not remove all widgets.");
    } finally {
      clearingWidgets = false;
    }
  });

  app.delete(
    "/api/widgets",
    requireJson,
    express.json({ limit: "4kb" }),
    async (request, response) => {
      const id = typeof request.body?.id === "string" ? request.body.id.trim() : "";
      if (!id) {
        return response.status(400).json({ error: "id must be a non-empty string.", code: "INVALID_WIDGET_ID" });
      }
      if (config.demoMode || !widgetStore?.enabled) {
        return response.status(409).json({ error: "Widget deletion requires a writable WIDGETS_FILE.", code: "WIDGET_FILE_UNAVAILABLE" });
      }
      if (!config.widgets.some((widget) => widget.id === id)) {
        return response.status(404).json({ error: "Widget was not found.", code: "WIDGET_NOT_FOUND" });
      }
      try {
        await widgetStore.remove(id);
        config.widgets = config.widgets.filter((widget) => widget.id !== id);
        discoveredById.delete(id);
        poller.removeWidget(id);
        return response.json({ id });
      } catch (error) {
        return sendOperationError(response, error, "WIDGET_DELETE_FAILED", "Dashboard could not delete the widget.");
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
    sendEvent(response, "discovery", autoDiscovery);
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
  const vendorFiles = {
    "/vendor/datatables.js": require.resolve("datatables.net/js/dataTables.min.js"),
    "/vendor/datatables.css": require.resolve("datatables.net-dt/css/dataTables.dataTables.min.css"),
    "/vendor/chart.js": path.join(path.dirname(require.resolve("chart.js")), "chart.umd.min.js"),
  };
  for (const [url, file] of Object.entries(vendorFiles)) {
    app.get(url, (request, response) => response.sendFile(file));
  }
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
