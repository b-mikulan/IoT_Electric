const grid = document.querySelector("#widget-grid");
const template = document.querySelector("#widget-template");
const demoBadge = document.querySelector("#demo-badge");
const emptyState = document.querySelector("#empty-state");
const errorBanner = document.querySelector("#error-banner");
const errorMessage = document.querySelector("#error-message");
const lastSync = document.querySelector("#last-sync");
const connectionDot = document.querySelector("#connection-dot");
const connectionLabel = document.querySelector("#connection-label");
const pollInterval = document.querySelector("#poll-interval");

const elementsById = new Map();
const configById = new Map();

function visualForUnit(unit = "") {
  const normalized = unit.trim().toLowerCase();

  if (normalized.includes("°c") || normalized === "c") {
    return { icon: "🌡", color: "#d35400", soft: "#fff1e8" };
  }
  if (normalized === "%" || normalized.includes("rh")) {
    return { icon: "💧", color: "#0277bd", soft: "#e6f4fb" };
  }
  if (normalized.includes("kw") || normalized.includes("w")) {
    return { icon: "⚡", color: "#b77900", soft: "#fff8dc" };
  }
  if (normalized.includes("v") || normalized.includes("a")) {
    return { icon: "⌁", color: "#6a4fb3", soft: "#f1edfc" };
  }

  return { icon: "●", color: "#00796b", soft: "#e4f4f1" };
}

function createWidget(widget) {
  const fragment = template.content.cloneNode(true);
  const column = fragment.querySelector(".widget-column");
  const card = fragment.querySelector(".widget-card");
  const icon = fragment.querySelector(".widget-icon");
  const visual = visualForUnit(widget.unit);

  card.dataset.widgetId = widget.id;
  card.style.setProperty("--widget-color", visual.color);
  card.style.setProperty("--widget-soft", visual.soft);
  icon.textContent = visual.icon;
  fragment.querySelector(".widget-label").textContent = widget.label;
  fragment.querySelector(".widget-description").textContent = widget.description;
  fragment.querySelector(".widget-unit").textContent = widget.unit;

  grid.appendChild(fragment);
  elementsById.set(widget.id, column);
  configById.set(widget.id, widget);
}

function formatValue(value, precision) {
  if (value === null || value === undefined || value === "") return "—";

  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    const decimals = precision ?? (Number.isInteger(numeric) ? 0 : 2);
    return new Intl.NumberFormat("hr-HR", {
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    }).format(numeric);
  }

  return String(value);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";

  return new Intl.DateTimeFormat("hr-HR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function updateWidget(widget, syncedAt) {
  const column = elementsById.get(widget.id);
  if (!column) return;

  const config = configById.get(widget.id) || {};
  const card = column.querySelector(".widget-card");
  const state = column.querySelector(".widget-state");

  column.querySelector(".widget-value").textContent = formatValue(
    widget.value,
    config.precision
  );
  const changedAt = Object.hasOwn(widget, "updatedAt")
    ? widget.updatedAt
    : syncedAt;
  const widgetTime = column.querySelector(".widget-time");
  widgetTime.textContent = `Promjena: ${formatTime(changedAt)}`;
  widgetTime.title = "Vrijeme kada je dashboard zadnji put uočio promjenu vrijednosti.";

  card.classList.toggle("has-error", Boolean(widget.error));
  state.classList.toggle("is-error", Boolean(widget.error));
  state.classList.toggle("is-current", !widget.error);
  state.textContent = widget.error || "Aktualno";

  card.classList.remove("is-updated");
  requestAnimationFrame(() => card.classList.add("is-updated"));
}

function showStatus(status = {}) {
  const state =
    typeof status === "string"
      ? status
      : status.state || status.status || "connecting";
  const isOnline = state === "connected" || state === "online";
  const isOffline = state === "error" || state === "offline";

  connectionDot.className = `connection-dot ${
    isOnline ? "is-online" : isOffline ? "is-offline" : "is-connecting"
  }`;
  connectionLabel.textContent = isOnline
    ? "Podaci uživo"
    : isOffline
      ? "Veza prekinuta"
      : "Povezivanje…";

  errorBanner.hidden = !isOffline;
  if (isOffline) {
    errorMessage.textContent =
      status.error || status.message || "Servis će pokušati ponovno.";
  }
}

function applyPayload(payload = {}) {
  const widgets = payload.widgets || payload.changed || [];
  for (const widget of widgets) updateWidget(widget, payload.syncedAt);

  const syncTime = payload.syncedAt || payload.lastSync;
  if (syncTime) {
    lastSync.textContent = `Zadnja uspješna provjera: ${formatTime(syncTime)}`;
  }
  if (payload.status) showStatus(payload);
}

async function boot() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Konfiguracija nije dostupna.");

    const config = await response.json();
    demoBadge.hidden = !config.demoMode;
    pollInterval.textContent = `Interval: ${Math.round(config.intervalMs / 1000)} s`;
    emptyState.hidden = config.widgets.length > 0;
    config.widgets.forEach(createWidget);

    const events = new EventSource("/events");
    events.addEventListener("snapshot", (event) => {
      applyPayload(JSON.parse(event.data));
    });
    events.addEventListener("update", (event) => {
      applyPayload(JSON.parse(event.data));
    });
    events.addEventListener("status", (event) => {
      applyPayload(JSON.parse(event.data));
    });
    events.addEventListener("sync", (event) => {
      applyPayload(JSON.parse(event.data));
    });
    events.onopen = () => showStatus({ state: "connecting" });
    events.onerror = () => showStatus({
      state: "offline",
      message: "Veza s dashboard servisom je prekinuta. Pokušavam ponovno.",
    });
  } catch (error) {
    showStatus({ state: "offline", message: error.message });
  }
}

boot();
