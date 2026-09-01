const fs = require("node:fs");

const DEFAULT_DEMO_WIDGETS = [
  {
    id: "demo-room-temperature",
    label: "Temperatura prostora",
    description: "Ured · prizemlje",
    unit: "°C",
    precision: 1,
    demoValue: 22.4,
  },
  {
    id: "demo-room-humidity",
    label: "Relativna vlažnost",
    description: "Ured · prizemlje",
    unit: "%",
    precision: 0,
    demoValue: 47,
  },
  {
    id: "demo-active-power",
    label: "Trenutna snaga",
    description: "Glavni razvod",
    unit: "kW",
    precision: 2,
    demoValue: 3.18,
  },
];

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;

  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInterval(value) {
  const intervalMs = Number(value || 15_000);

  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("POLL_INTERVAL_MS must be an integer of at least 1000.");
  }

  return intervalMs;
}

function parseTimeout(value) {
  const timeoutMs = Number(value || 10_000);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error("MIDDLEWARE_TIMEOUT_MS must be an integer of at least 100.");
  }

  return timeoutMs;
}

function readMiddlewarePassword(env) {
  if (env.MIDDLEWARE_PASSWORD) return String(env.MIDDLEWARE_PASSWORD);
  if (!env.MIDDLEWARE_PASSWORD_FILE) return "";

  try {
    return fs
      .readFileSync(String(env.MIDDLEWARE_PASSWORD_FILE), "utf8")
      .replace(/\r?\n$/, "");
  } catch (error) {
    throw new Error(`Unable to read MIDDLEWARE_PASSWORD_FILE: ${error.message}`);
  }
}

function readWidgetConfiguration(env) {
  const inlineWidgets = String(env.WIDGETS_JSON || "").trim();
  if (inlineWidgets) return inlineWidgets;

  const filePath = String(env.WIDGETS_FILE || "").trim();
  if (!filePath) return "";

  try {
    return fs
      .readFileSync(filePath, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
  } catch (error) {
    throw new Error(`Unable to read WIDGETS_FILE ${filePath}: ${error.message}`);
  }
}

function normalizeWidget(widget, index) {
  if (!widget || typeof widget !== "object" || Array.isArray(widget)) {
    throw new Error(`Widget ${index + 1} must be an object.`);
  }

  const id = String(widget.id || "").trim();
  if (!id) {
    throw new Error(`Widget ${index + 1} is missing an id.`);
  }

  const precision =
    widget.precision === undefined ? undefined : Number(widget.precision);

  if (
    precision !== undefined &&
    (!Number.isInteger(precision) || precision < 0 || precision > 6)
  ) {
    throw new Error(`Widget ${id} has an invalid precision.`);
  }

  if (widget.writable !== undefined && typeof widget.writable !== "boolean") {
    throw new Error(`Widget ${id} has an invalid writable flag.`);
  }

  if (widget.visible !== undefined && typeof widget.visible !== "boolean") {
    throw new Error(`Widget ${id} has an invalid visible flag.`);
  }

  return {
    id,
    label: String(widget.label || id),
    description: String(widget.description || "PLC vrijednost"),
    unit: String(widget.unit || ""),
    ...(precision === undefined ? {} : { precision }),
    ...(widget.demoValue === undefined ? {} : { demoValue: widget.demoValue }),
    writable: widget.writable === true,
    visible: widget.visible !== false,
  };
}

function parseWidgets(rawWidgets, demoMode) {
  if (!rawWidgets) {
    if (demoMode) return DEFAULT_DEMO_WIDGETS.map((widget) => ({ ...widget }));

    throw new Error(
      "WIDGETS_JSON or WIDGETS_FILE is required when DEMO_MODE is disabled."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawWidgets);
  } catch (error) {
    throw new Error(`Widget configuration is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Widget configuration must contain a non-empty array.");
  }

  const widgets = parsed.map(normalizeWidget);
  const ids = new Set();

  for (const widget of widgets) {
    if (ids.has(widget.id)) {
      throw new Error(`Widget configuration contains duplicate id: ${widget.id}`);
    }
    ids.add(widget.id);
  }

  return widgets;
}

function loadConfig(env = process.env) {
  const rawWidgets = readWidgetConfiguration(env);
  const inlineWidgets = String(env.WIDGETS_JSON || "").trim();
  const widgetsFile = inlineWidgets
    ? ""
    : String(env.WIDGETS_FILE || "").trim();
  const demoMode = parseBoolean(env.DEMO_MODE, !rawWidgets);
  const widgets = parseWidgets(rawWidgets, demoMode);
  const password = readMiddlewarePassword(env);
  const port = Number(env.PORT || 3001);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  if (!demoMode && (!env.MIDDLEWARE_USER || !password)) {
    throw new Error(
      "MIDDLEWARE_USER and either MIDDLEWARE_PASSWORD or MIDDLEWARE_PASSWORD_FILE are required when DEMO_MODE is disabled."
    );
  }

  return {
    port,
    demoMode,
    intervalMs: parseInterval(env.POLL_INTERVAL_MS),
    timeoutMs: parseTimeout(env.MIDDLEWARE_TIMEOUT_MS),
    middlewareUrl: String(
      env.MIDDLEWARE_URL || "http://127.0.0.1:3000"
    ).replace(/\/+$/, ""),
    username: String(env.MIDDLEWARE_USER || ""),
    password,
    widgets,
    widgetsFile,
  };
}

module.exports = {
  DEFAULT_DEMO_WIDGETS,
  loadConfig,
  parseWidgets,
  readWidgetConfiguration,
};
