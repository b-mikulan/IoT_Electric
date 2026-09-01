const { EventEmitter } = require("node:events");
const { isDeepStrictEqual } = require("node:util");

const NO_VALUE_ERROR = "No value returned by middleware";

class PointWriteError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "PointWriteError";
    this.status = status;
    this.code = code;
  }
}

class PointDiscoveryError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "PointDiscoveryError";
    this.status = status;
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function normalizeWidget(widget, index) {
  const normalized =
    typeof widget === "string" ? { id: widget } : { ...widget };

  if (!normalized || typeof normalized.id !== "string" || !normalized.id.trim()) {
    throw new TypeError(`widgets[${index}].id must be a non-empty string`);
  }

  normalized.id = normalized.id.trim();
  delete normalized.value;
  delete normalized.state;
  delete normalized.error;
  delete normalized.updatedAt;
  normalized.writable = normalized.writable === true;
  normalized.visible = normalized.visible !== false;

  return normalized;
}

function timestampFrom(now) {
  const supplied = now();
  const date = supplied instanceof Date ? supplied : new Date(supplied);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("now() must return a valid Date or date value");
  }

  return date.toISOString();
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function demoValue(widget, random) {
  const sample = Math.min(1, Math.max(0, Number(random()) || 0));
  const unit = String(widget.unit || "").trim().toLowerCase();

  if (unit.includes("°c") || unit === "c" || unit === "celsius") {
    return round(18 + sample * 9, 1);
  }

  if (unit === "%" || unit.includes("percent")) {
    return round(sample * 100, 1);
  }

  if (unit === "v" || unit === "volt" || unit === "volts") {
    return round(220 + sample * 20, 1);
  }

  if (unit === "kw" || unit === "kilowatt" || unit === "kilowatts") {
    return round(sample * 12, 2);
  }

  return round(sample * 100, 2);
}

function pointChanged(previous, next) {
  return (
    !previous ||
    !isDeepStrictEqual(previous.value, next.value) ||
    !isDeepStrictEqual(previous.state, next.state) ||
    !isDeepStrictEqual(previous.error, next.error)
  );
}

function itemName(item) {
  const id = String(item?.id || "").trim();
  const fallback = id.split("/").filter(Boolean).at(-1) || id;
  return String(item?.name || fallback || "Neimenovani objekt");
}

class PointPoller extends EventEmitter {
  #middlewareUrl;

  #username;

  #password;

  #widgets;

  #intervalMs;

  #timeoutMs;

  #fetch;

  #demoMode;

  #now;

  #random;

  #timer = null;

  #pollPromise = null;

  #writesInFlight = new Set();

  constructor({
    middlewareUrl,
    username,
    password,
    widgets,
    intervalMs = 15_000,
    timeoutMs = 10_000,
    fetchImpl = globalThis.fetch,
    demoMode = false,
    now = () => new Date(),
    random = Math.random,
  }) {
    super();

    if (!Array.isArray(widgets)) {
      throw new TypeError("widgets must be an array");
    }

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError("intervalMs must be a positive number");
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive number");
    }

    if (typeof now !== "function" || typeof random !== "function") {
      throw new TypeError("now and random must be functions");
    }

    if (!demoMode) {
      if (typeof middlewareUrl !== "string" || !middlewareUrl.trim()) {
        throw new TypeError("middlewareUrl is required outside demo mode");
      }

      if (typeof fetchImpl !== "function") {
        throw new TypeError("fetchImpl must be a function outside demo mode");
      }
    }

    this.#middlewareUrl = String(middlewareUrl || "").trim().replace(/\/+$/, "");
    this.#username = String(username || "");
    this.#password = String(password || "");
    this.#widgets = widgets.map(normalizeWidget);
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
    this.#demoMode = demoMode;
    this.#now = now;
    this.#random = random;

    this.snapshot = {
      status: "idle",
      syncedAt: null,
      error: null,
      widgets: this.#widgets.map((widget) => ({
        ...clone(widget),
        value: null,
        state: null,
        error: null,
        updatedAt: null,
      })),
    };
  }

  start() {
    if (this.#timer !== null) {
      return this;
    }

    void this.poll();
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#intervalMs);

    if (typeof this.#timer.unref === "function") {
      this.#timer.unref();
    }

    return this;
  }

  stop() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    return this;
  }

  async poll() {
    if (this.#pollPromise) {
      return this.#pollPromise;
    }

    const operation = this.#performPoll();
    this.#pollPromise = operation;

    try {
      return await operation;
    } finally {
      if (this.#pollPromise === operation) {
        this.#pollPromise = null;
      }
    }
  }

  getSnapshot() {
    return clone(this.snapshot);
  }

  addWidget(widget) {
    const normalized = normalizeWidget(widget, this.#widgets.length);
    if (this.#widgets.some((item) => item.id === normalized.id)) {
      throw new PointDiscoveryError(
        "This object is already on the dashboard.",
        409,
        "WIDGET_ALREADY_EXISTS"
      );
    }

    normalized.writable = false;
    this.#widgets.push(normalized);
    this.snapshot.widgets.push({
      ...clone(normalized),
      value: null,
      state: null,
      error: null,
      updatedAt: null,
    });

    this.emit("config", { widget: clone(normalized) });
    void this.#refreshAfterWidgetAdd();
    return clone(normalized);
  }

  updateWidget(id, settings) {
    const widgetId = typeof id === "string" ? id.trim() : "";
    const index = this.#widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) {
      throw new PointDiscoveryError(
        "Widget was not found in the running dashboard.",
        404,
        "WIDGET_NOT_FOUND"
      );
    }

    const normalized = normalizeWidget(
      { ...this.#widgets[index], ...settings, id: widgetId },
      index
    );
    this.#widgets[index] = normalized;

    const current = this.snapshot.widgets[index] || {};
    this.snapshot.widgets[index] = {
      ...clone(normalized),
      value: Object.hasOwn(current, "value") ? current.value : null,
      state: Object.hasOwn(current, "state") ? current.state : null,
      error: Object.hasOwn(current, "error") ? current.error : null,
      updatedAt: Object.hasOwn(current, "updatedAt")
        ? current.updatedAt
        : null,
    };

    this.emit("config", { widget: clone(normalized) });
    return clone(normalized);
  }

  async discoverObjects(query = "") {
    if (this.#demoMode) {
      throw new PointDiscoveryError(
        "Object discovery is unavailable in demo mode.",
        409,
        "DEMO_MODE"
      );
    }

    const containerId = typeof query === "string" ? query.trim() : "";
    if (containerId.length > 1_024 || /[\r\n\0]/.test(containerId)) {
      throw new PointDiscoveryError(
        "Container or object ID is not valid.",
        400,
        "INVALID_DISCOVERY_QUERY"
      );
    }

    let payload = null;
    let initialError = null;
    try {
      payload = await this.#fetchContainer(containerId);
    } catch (error) {
      initialError = error;
    }

    const initial = payload ? this.#normalizeDiscoveryItems(payload) : [];
    if (initial.length > 0 || !containerId) {
      if (initialError) throw initialError;
      return this.#discoveryResponse(containerId, initial, payload);
    }

    const slash = containerId.lastIndexOf("/");
    const parentId = slash >= 0 ? containerId.slice(0, slash) : "";
    if (parentId !== containerId) {
      try {
        const parentPayload = await this.#fetchContainer(parentId);
        const exact = this.#normalizeDiscoveryItems(parentPayload).find(
          (item) => item.kind === "value" && item.id === containerId
        );
        if (exact) {
          return this.#discoveryResponse(parentId, [exact], parentPayload, true);
        }
      } catch (error) {
        if (!initialError) initialError = error;
      }
    }

    if (initialError) throw initialError;
    return this.#discoveryResponse(containerId, [], payload);
  }

  async writeValue(id, value) {
    if (this.#demoMode) {
      throw new PointWriteError(
        "Writing is unavailable in demo mode.",
        409,
        "DEMO_MODE"
      );
    }

    const pointId = typeof id === "string" ? id.trim() : "";
    const widget = this.#widgets.find((item) => item.id === pointId);
    if (!widget || widget.writable !== true) {
      throw new PointWriteError(
        "This dashboard point is not writable.",
        403,
        "POINT_NOT_WRITABLE"
      );
    }

    const valueType = typeof value;
    const isSupportedValue =
      valueType === "string" ||
      valueType === "boolean" ||
      (valueType === "number" && Number.isFinite(value));
    if (!isSupportedValue) {
      throw new PointWriteError(
        "Value must be a string, finite number, or boolean.",
        400,
        "INVALID_VALUE"
      );
    }

    const current = this.snapshot.widgets.find((item) => item.id === pointId);
    if (this.snapshot.status !== "connected" || !current || current.error) {
      throw new PointWriteError(
        "The point is not currently available for writing.",
        409,
        "POINT_UNAVAILABLE"
      );
    }

    if (this.#writesInFlight.has(pointId)) {
      throw new PointWriteError(
        "A write for this point is already in progress.",
        409,
        "WRITE_IN_PROGRESS"
      );
    }

    this.#writesInFlight.add(pointId);
    const authorization = Buffer.from(
      `${this.#username}:${this.#password}`,
      "utf8"
    ).toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(
        `${this.#middlewareUrl}/api/values/write`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${authorization}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ items: [{ id: pointId, value }] }),
          signal: controller.signal,
        }
      );

      if (!response || !response.ok) {
        const status = response?.status ? ` (${response.status})` : "";
        throw new PointWriteError(
          `Middleware rejected the write request${status}.`,
          502,
          "MIDDLEWARE_WRITE_FAILED"
        );
      }

      const payload = await response.json();
      const result = Array.isArray(payload?.results)
        ? payload.results.find((item) => item?.id === pointId)
        : null;

      if (!result) {
        throw new PointWriteError(
          "Middleware did not return a result for this point.",
          502,
          "MISSING_WRITE_RESULT"
        );
      }

      if (result.success !== true) {
        throw new PointWriteError(
          String(result.message || "The controller rejected the value."),
          422,
          "CONTROLLER_REJECTED"
        );
      }

      const refresh = setImmediate(() => void this.poll());
      refresh.unref?.();

      return {
        id: pointId,
        success: true,
        message: String(result.message || ""),
      };
    } catch (error) {
      if (error instanceof PointWriteError) throw error;

      if (controller.signal.aborted) {
        throw new PointWriteError(
          "Middleware write timed out. Check the current value before trying again.",
          504,
          "WRITE_TIMEOUT"
        );
      }

      throw new PointWriteError(
        "Middleware write failed. Check the current value before trying again.",
        502,
        "MIDDLEWARE_WRITE_FAILED"
      );
    } finally {
      clearTimeout(timeout);
      this.#writesInFlight.delete(pointId);
    }
  }

  async #refreshAfterWidgetAdd() {
    if (this.#pollPromise) await this.#pollPromise;
    await this.poll();
  }

  #discoveryResponse(containerId, items, payload, exactMatch = false) {
    const limit = 500;
    return {
      containerId,
      exactMatch,
      items: items.slice(0, limit),
      truncated: items.length > limit,
      errors: Array.isArray(payload?.errors)
        ? payload.errors.map((item) => ({
            id: String(item?.id || ""),
            message: String(item?.message || "Unknown discovery error"),
          }))
        : [],
    };
  }

  #normalizeDiscoveryItems(payload) {
    const configured = new Set(this.#widgets.map((widget) => widget.id));
    const results = new Map();
    const containers = Array.isArray(payload?.containers)
      ? payload.containers
      : [];

    for (const container of containers) {
      const context = String(container?.name || container?.id || "PLC objekt");
      const childContainers = Array.isArray(container?.containerItems)
        ? container.containerItems
        : [];
      const valueItems = Array.isArray(container?.valueItems)
        ? container.valueItems
        : [];

      for (const item of childContainers) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        results.set(id, {
          id,
          kind: "container",
          name: itemName(item),
          description: String(item?.description || context),
          type: String(item?.type || "Container"),
          unit: "",
          controllerWritable: false,
          alreadyAdded: configured.has(id),
        });
      }

      for (const item of valueItems) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        results.set(id, {
          id,
          kind: "value",
          name: itemName(item),
          description: String(item?.description || context),
          type: String(item?.type || "ValueItem"),
          unit: String(item?.unit || ""),
          controllerWritable: Number(item?.writeable) === 1,
          alreadyAdded: configured.has(id),
        });
      }
    }

    return [...results.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "container" ? -1 : 1;
      return left.name.localeCompare(right.name, "hr");
    });
  }

  async #fetchContainer(containerId) {
    const authorization = Buffer.from(
      `${this.#username}:${this.#password}`,
      "utf8"
    ).toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const url = new URL(`${this.#middlewareUrl}/api/containers`);
      url.searchParams.set("id", containerId);
      const response = await this.#fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${authorization}`,
        },
        signal: controller.signal,
      });

      if (!response || !response.ok) {
        throw new PointDiscoveryError(
          `Middleware rejected the discovery request${response?.status ? ` (${response.status})` : ""}.`,
          502,
          "MIDDLEWARE_DISCOVERY_FAILED"
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof PointDiscoveryError) throw error;
      if (controller.signal.aborted) {
        throw new PointDiscoveryError(
          "Object discovery timed out.",
          504,
          "DISCOVERY_TIMEOUT"
        );
      }
      throw new PointDiscoveryError(
        "Object discovery through middleware failed.",
        502,
        "MIDDLEWARE_DISCOVERY_FAILED"
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async #performPoll() {
    try {
      const points = this.#demoMode
        ? this.#createDemoPoints()
        : await this.#fetchPoints();
      const syncedAt = timestampFrom(this.#now);
      const previousById = new Map(
        this.snapshot.widgets.map((widget) => [widget.id, widget])
      );
      const evaluatedWidgets = this.#widgets.map((widget) => {
        const previous = previousById.get(widget.id);
        const nextPoint = {
          ...clone(widget),
          ...(points.get(widget.id) || {
            value: null,
            state: null,
            error: NO_VALUE_ERROR,
          }),
        };
        const changed = !previous?.updatedAt || pointChanged(previous, nextPoint);

        return {
          changed,
          widget: {
            ...nextPoint,
            updatedAt: changed ? syncedAt : previous.updatedAt,
          },
        };
      });
      const nextWidgets = evaluatedWidgets.map(({ widget }) => widget);
      const changedWidgets = evaluatedWidgets
        .filter(({ changed }) => changed)
        .map(({ widget }) => widget);
      const previousStatus = this.snapshot.status;

      this.snapshot = {
        status: "connected",
        syncedAt,
        error: null,
        widgets: nextWidgets,
      };

      if (previousStatus !== "connected") {
        this.emit("status", {
          status: "connected",
          syncedAt,
          error: null,
        });
      }

      this.emit("sync", {
        status: "connected",
        syncedAt,
        error: null,
      });

      if (changedWidgets.length > 0) {
        this.emit("update", {
          syncedAt,
          widgets: clone(changedWidgets),
        });
      }

      return this.getSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const previousStatus = this.snapshot.status;
      const previousError = this.snapshot.error;

      this.snapshot = {
        ...this.snapshot,
        status: "error",
        error: message,
      };

      if (previousStatus !== "error" || previousError !== message) {
        this.emit("status", {
          status: "error",
          syncedAt: this.snapshot.syncedAt,
          error: message,
        });
      }

      return this.getSnapshot();
    }
  }

  async #fetchPoints() {
    const authorization = Buffer.from(
      `${this.#username}:${this.#password}`,
      "utf8"
    ).toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    // Keep the timeout referenced so its abort can fire while poll() is pending.
    let payload;

    try {
      const response = await this.#fetch(
        `${this.#middlewareUrl}/api/values/read`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${authorization}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ids: this.#widgets.map(({ id }) => id) }),
          signal: controller.signal,
        }
      );

      if (!response || !response.ok) {
        const status = response && response.status ? ` ${response.status}` : "";
        throw new Error(`Middleware request failed${status}`);
      }

      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Middleware request timed out after ${this.#timeoutMs} ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const values = payload && Array.isArray(payload.values) ? payload.values : [];
    const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
    const points = new Map();

    for (const item of values) {
      if (!item || typeof item.id !== "string") {
        continue;
      }

      points.set(item.id, {
        value: Object.hasOwn(item, "value") ? item.value : null,
        state: Object.hasOwn(item, "state") ? item.state : null,
        error: null,
      });
    }

    for (const item of errors) {
      if (!item || typeof item.id !== "string") {
        continue;
      }

      points.set(item.id, {
        value: null,
        state: null,
        error: item.message ? String(item.message) : "Unknown point error",
      });
    }

    return points;
  }

  #createDemoPoints() {
    return new Map(
      this.#widgets.map((widget) => [
        widget.id,
        {
          value: demoValue(widget, this.#random),
          state: "ok",
          error: null,
        },
      ])
    );
  }
}

module.exports = {
  PointPoller,
  PointDiscoveryError,
  PointWriteError,
};
