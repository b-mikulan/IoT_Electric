const { EventEmitter } = require("node:events");
const { isDeepStrictEqual } = require("node:util");

const NO_VALUE_ERROR = "No value returned by middleware";

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

  async #performPoll() {
    try {
      const points = this.#demoMode
        ? this.#createDemoPoints()
        : await this.#fetchPoints();
      const syncedAt = timestampFrom(this.#now);
      const previousById = new Map(
        this.snapshot.widgets.map((widget) => [widget.id, widget])
      );
      const nextWidgets = this.#widgets.map((widget) => ({
        ...clone(widget),
        ...(points.get(widget.id) || {
          value: null,
          state: null,
          error: NO_VALUE_ERROR,
        }),
      }));
      const changedWidgets = nextWidgets.filter((widget) =>
        pointChanged(previousById.get(widget.id), widget)
      );
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
    // This timer guarantees that poll() settles even when fetch never does.
    // Keep it referenced until the request finishes or the timeout aborts it.
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
};
