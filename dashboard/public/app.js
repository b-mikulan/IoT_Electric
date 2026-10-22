const grid = document.querySelector("#widget-grid");
const { widgetGroup, describeWidgetGroup, deriveWidgetGroup } = globalThis.IoTWidgetGrouping;
const template = document.querySelector("#widget-template");
const demoBadge = document.querySelector("#demo-badge");
const emptyState = document.querySelector("#empty-state");
const errorBanner = document.querySelector("#error-banner");
const errorMessage = document.querySelector("#error-message");
const lastSync = document.querySelector("#last-sync");
const connectionDot = document.querySelector("#connection-dot");
const connectionLabel = document.querySelector("#connection-label");
const pollInterval = document.querySelector("#poll-interval");
const controlPanel = document.querySelector("#control-panel");
const writeForm = document.querySelector("#write-form");
const writeWidget = document.querySelector("#write-widget");
const writeValue = document.querySelector("#write-value");
const writeValueLabel = document.querySelector("#write-value-label");
const writeSubmit = document.querySelector("#write-submit");
const writeStatus = document.querySelector("#write-status");
const discoveryOpen = document.querySelector("#discovery-open");
const discoveryDialog = document.querySelector("#discovery-dialog");
const discoveryClose = document.querySelector("#discovery-close");
const discoveryForm = document.querySelector("#discovery-form");
const discoveryQuery = document.querySelector("#discovery-query");
const discoverySearch = document.querySelector("#discovery-search");
const discoveryStatus = document.querySelector("#discovery-status");
const discoveryResults = document.querySelector("#discovery-results");
const automaticDiscovery = document.querySelector("#automatic-discovery");
const discoveryAuto = document.querySelector("#discovery-auto");
const discoveryAutoStatus = document.querySelector("#discovery-auto-status");
const discoveryTree = document.querySelector("#discovery-tree");
const treeValuesById = new Map();
const discoveryItemTemplate = document.querySelector("#discovery-item-template");
const visibilityOpen = document.querySelector("#visibility-open");
const visibilityDialog = document.querySelector("#visibility-dialog");
const visibilityClose = document.querySelector("#visibility-close");
const visibilityList = document.querySelector("#visibility-list");
const visibilityStatus = document.querySelector("#visibility-status");
const widgetsClear = document.querySelector("#widgets-clear");
const widgetsClearConfirmation = document.querySelector("#widgets-clear-confirmation");
const widgetsClearMessage = document.querySelector("#widgets-clear-message");
const widgetsClearCancel = document.querySelector("#widgets-clear-cancel");
const widgetsClearConfirm = document.querySelector("#widgets-clear-confirm");
const widgetsClearStatus = document.querySelector("#widgets-clear-status");
const widgetsGroupSelect = document.querySelector("#widgets-group-select");
const widgetsGroupClear = document.querySelector("#widgets-group-clear");
const widgetsGroupRename = document.querySelector("#widgets-group-rename");
const groupRenameDialog = document.querySelector("#group-rename-dialog");
const groupRenameClose = document.querySelector("#group-rename-close");
const groupRenameCancel = document.querySelector("#group-rename-cancel");
const groupRenameForm = document.querySelector("#group-rename-form");
const groupRenameName = document.querySelector("#group-rename-name");
const groupRenameSave = document.querySelector("#group-rename-save");
const groupRenameMessage = document.querySelector("#group-rename-message");
const groupRenameStatus = document.querySelector("#group-rename-status");
const groupClearDialog = document.querySelector("#group-clear-dialog");
const groupClearClose = document.querySelector("#group-clear-close");
const groupClearCancel = document.querySelector("#group-clear-cancel");
const groupClearConfirm = document.querySelector("#group-clear-confirm");
const groupClearMessage = document.querySelector("#group-clear-message");
const groupClearStatus = document.querySelector("#group-clear-status");
const visibilityItemTemplate = document.querySelector("#visibility-item-template");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsClose = document.querySelector("#settings-close");
const settingsCancel = document.querySelector("#settings-cancel");
const settingsForm = document.querySelector("#settings-form");
const settingsTitle = document.querySelector("#settings-title");
const settingsPointField = document.querySelector("#settings-point-field");
const settingsPoint = document.querySelector("#settings-point");
const settingsContext = document.querySelector("#settings-context");
const settingsWriteHint = document.querySelector("#settings-write-hint");
const settingsId = document.querySelector("#settings-id");
const settingsLabel = document.querySelector("#settings-label");
const settingsDescription = document.querySelector("#settings-description");
const settingsGroup = document.querySelector("#settings-group");
const settingsUnit = document.querySelector("#settings-unit");
const settingsPrecision = document.querySelector("#settings-precision");
const settingsWritable = document.querySelector("#settings-writable");
const settingsVisible = document.querySelector("#settings-visible");
const settingsSave = document.querySelector("#settings-save");
const settingsStatus = document.querySelector("#settings-status");
const settingsDelete = document.querySelector("#settings-delete");
const settingsDeleteConfirmation = document.querySelector("#settings-delete-confirmation");
const settingsDeleteMessage = document.querySelector("#settings-delete-message");
const settingsDeleteConfirm = document.querySelector("#settings-delete-confirm");
const settingsDeleteCancel = document.querySelector("#settings-delete-cancel");
const cardSettings = Object.fromEntries([
  "dialog", "title", "close", "form", "label", "label-hint", "room", "new-room-field", "new-room",
  "primary", "unit-mode", "unit", "unit-field", "unit-hint", "secondary-mode", "secondary-hint", "secondary-field", "search", "secondary-list",
  "secondary-count", "functions", "reset", "cancel", "save", "status",
].map((name) => [name, document.querySelector(`#device-settings-${name}`)]));

const elementsById = new Map();
const configById = new Map();
const visibilityInputsById = new Map();
const latestValuesById = new Map();
const groupsByName = new Map();
const groupByWidgetId = new Map();
let widgetEditingEnabled = false;
let settingsBusy = false;
let settingsDeviceContext = null;
let lastDiscoveryPayload = null;
let updatingWidgets = false;
let automaticDiscoveryRunning = false;
let widgetClearBusy = false;
let groupClearTarget = "";
let groupRenameTarget = "";
let deviceCardView = null;
let deviceMetadata = { metadataById: {}, roomByZone: {} };
let deviceDemoWidgets = [];
let deviceDemoMode = false;
let deviceConnectionStatus = "connecting";
let deviceReadAt = null;
let deviceMetadataRequest = 0;
let deviceMetadataRefreshTimer;
const deviceSettingsByKey = new Map();
let deviceSettingsEnabled = false;
let deviceSettingsWarning = "";
let deviceSettingsRequest = 0;
let cardSettingsContext = null;
let cardSettingsBusy = false;

function refreshDeviceCards() {
  if (!deviceCardView || updatingWidgets) return;
  const widgets = deviceDemoMode && deviceDemoWidgets.length
    ? deviceDemoWidgets
    : [...configById.values()].map((config) => {
      const point = latestValuesById.get(config.id)?.widget;
      return { ...config, ...(point ? { value: point.value, state: point.state, error: point.error, updatedAt: point.updatedAt } : {}) };
    });
  deviceCardView.update({ widgets, status: deviceConnectionStatus, readAt: deviceReadAt, demo: deviceDemoMode,
    ...deviceMetadata, settingsEnabled: widgetEditingEnabled || deviceSettingsEnabled,
    deviceSettings: [...deviceSettingsByKey.values()],
    warnings: [...(deviceMetadata.warnings || []), ...(deviceSettingsWarning ? [deviceSettingsWarning] : [])],
  });
}

function applyDeviceSettings(entries) {
  if (!Array.isArray(entries)) return;
  deviceSettingsByKey.clear();
  for (const entry of entries) if (typeof entry?.key === "string") deviceSettingsByKey.set(entry.key, entry);
  deviceSettingsWarning = "";
  refreshDeviceCards();
}

async function refreshSavedDeviceSettings() {
  const request = ++deviceSettingsRequest;
  try {
    const response = await fetch("/api/devices/settings", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.devices)) throw new Error(payload.error || "Postavke kartica nisu dostupne.");
    if (request !== deviceSettingsRequest) return;
    deviceSettingsEnabled = payload.enabled === true;
    applyDeviceSettings(payload.devices);
  } catch {
    if (request !== deviceSettingsRequest) return;
    deviceSettingsWarning = "Spremljene postavke kartica trenutačno nisu dostupne. Prethodni odabir je sačuvan.";
    refreshDeviceCards();
  }
}

async function refreshDeviceMetadata() {
  const request = ++deviceMetadataRequest;
  try {
    const response = await fetch("/api/devices/metadata", { cache: "no-store" });
    if (!response.ok) throw new Error("Opisi uređaja nisu dostupni.");
    const payload = await response.json();
    if (request !== deviceMetadataRequest) return;
    deviceMetadata = { metadataById: payload.metadataById || {}, roomByZone: payload.roomByZone || {}, warnings: payload.warnings || [] };
    deviceDemoWidgets = deviceDemoMode && Array.isArray(payload.demoWidgets) ? payload.demoWidgets : [];
  } catch {
    if (request !== deviceMetadataRequest) return;
    deviceMetadata = { ...deviceMetadata, warnings: ["Opisi uređaja trenutačno nisu dostupni."] };
  }
  refreshDeviceCards();
}

function scheduleDeviceMetadataRefresh() {
  clearTimeout(deviceMetadataRefreshTimer);
  deviceMetadataRefreshTimer = setTimeout(() => void refreshDeviceMetadata(), 150);
}

async function writeDeviceCommand({ widgetId, value }) {
  const response = await fetch("/api/devices/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widgetId, value }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Upis nije uspio (${response.status}).`);
  if (payload.success !== true || payload.id !== widgetId) {
    throw new Error("Nije primljena valjana potvrda upisa. Provjeri očitanje prije ponovnog pokušaja.");
  }
  return payload;
}

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

function widgetGroupName(widget) {
  return widgetGroup(widget);
}

function placeWidgetInGroup(widget, column) {
  const name = widgetGroupName(widget);
  const heading = describeWidgetGroup(widget);
  let group = groupsByName.get(name);
  if (!group) {
    const section = document.createElement("details");
    section.className = "widget-group";
    section.open = true;
    const summary = document.createElement("summary");
    summary.className = "widget-group-summary";
    const title = document.createElement("h2");
    title.className = "widget-group-title";
    title.textContent = heading.label;
    const copy = document.createElement("div");
    copy.className = "widget-group-copy";
    const context = document.createElement("span");
    context.className = "widget-group-context";
    context.textContent = heading.context;
    context.hidden = !heading.context;
    copy.append(title, context);
    copy.title = name;
    const count = document.createElement("span");
    count.className = "widget-group-count";
    const actions = document.createElement("div");
    actions.className = "widget-group-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "btn-flat";
    rename.textContent = "Preimenuj";
    rename.hidden = !widgetEditingEnabled;
    rename.setAttribute("aria-label", `Preimenuj grupu ${heading.label}`);
    rename.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openGroupRenameDialog(name);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-flat danger-action widget-group-delete";
    remove.textContent = "Obriši grupu";
    remove.hidden = !widgetEditingEnabled;
    remove.setAttribute("aria-label", `Obriši grupu ${heading.label}`);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openGroupClearDialog(name);
    });
    actions.append(rename, remove);
    summary.append(copy, count, actions);
    const body = document.createElement("div");
    body.className = "widget-group-body";
    const cards = document.createElement("div");
    cards.className = "row widget-group-grid";
    body.appendChild(cards);
    section.append(summary, body);
    grid.appendChild(section);
    group = { section, cards, count, remove, rename, heading };
    groupsByName.set(name, group);
  }
  if (column.parentElement !== group.cards) group.cards.appendChild(column);
  groupByWidgetId.set(widget.id, name);
}

function updateGroups() {
  if (updatingWidgets) return;
  const counts = new Map();
  for (const widget of configById.values()) {
    const name = groupByWidgetId.get(widget.id);
    const count = counts.get(name) || { total: 0, visible: 0 };
    count.total += 1;
    if (widget.visible !== false) count.visible += 1;
    counts.set(name, count);
  }
  for (const [name, group] of groupsByName) {
    const count = counts.get(name);
    if (!count) {
      group.section.remove();
      groupsByName.delete(name);
    } else {
      group.section.hidden = count.visible === 0;
      group.count.textContent = `Točke: ${count.visible}${count.visible === count.total ? "" : ` / ${count.total}`}`;
    }
  }
  const selection = widgetsGroupSelect.value;
  widgetsGroupSelect.replaceChildren(new Option("Odaberi grupu", ""));
  [...groupsByName.entries()].sort(([left], [right]) => left.localeCompare(right, "hr")).forEach(([name, group], index) => {
    if (grid.children[index] !== group.section) grid.insertBefore(group.section, grid.children[index] || null);
    const heading = [group.heading.label, group.heading.context].filter(Boolean).join(" · ");
    widgetsGroupSelect.add(new Option(`${heading} (${counts.get(name).total})`, name));
  });
  widgetsGroupSelect.value = groupsByName.has(selection) ? selection : "";
}

function updateClearButton() {
  widgetsClear.disabled = widgetClearBusy || automaticDiscoveryRunning || configById.size === 0;
  widgetsClearConfirm.disabled = widgetsClear.disabled;
  widgetsClear.title = automaticDiscoveryRunning ? "Pričekaj završetak automatskog dodavanja." : "";
  if (configById.size === 0 && !widgetClearBusy) widgetsClearConfirmation.hidden = true;
  if (!widgetsClearConfirmation.hidden && !widgetClearBusy) widgetsClearMessage.textContent = `Obrisati sve widgete s dashboarda (${configById.size})?`;
  widgetsGroupSelect.disabled = widgetClearBusy || automaticDiscoveryRunning;
  widgetsGroupClear.disabled = widgetClearBusy || automaticDiscoveryRunning || !widgetsGroupSelect.value;
  widgetsGroupRename.disabled = widgetsGroupClear.disabled;
  for (const group of groupsByName.values()) {
    group.remove.disabled = widgetClearBusy || automaticDiscoveryRunning;
    group.rename.disabled = group.remove.disabled;
  }
  if (groupClearDialog.open) {
    const count = [...configById.values()].filter((widget) => widgetGroupName(widget) === groupClearTarget).length;
    groupClearMessage.textContent = count > 0 ? `Obrisati grupu „${groupClearTarget}” i sve njezine widgete (${count})?` : "Grupa više nema widgeta.";
    groupClearConfirm.disabled = widgetClearBusy || automaticDiscoveryRunning || count === 0;
  }
  if (groupRenameDialog.open) {
    const count = [...configById.values()].filter((widget) => widgetGroupName(widget) === groupRenameTarget).length;
    groupRenameMessage.textContent = count > 0 ? `Grupa „${groupRenameTarget}” · widgeta: ${count}` : "Grupa više nije dostupna. Zatvori dijalog i odaberi grupu ponovno.";
    groupRenameSave.disabled = widgetClearBusy || automaticDiscoveryRunning || count === 0;
  }
}

function createWidget(widget) {
  if (configById.has(widget.id)) return;

  const fragment = template.content.cloneNode(true);
  const column = fragment.querySelector(".widget-column");
  const card = fragment.querySelector(".widget-card");
  const icon = fragment.querySelector(".widget-icon");
  const settingsButton = fragment.querySelector(".widget-settings-button");
  const visual = visualForUnit(widget.unit);

  card.dataset.widgetId = widget.id;
  card.style.setProperty("--widget-color", visual.color);
  card.style.setProperty("--widget-soft", visual.soft);
  icon.textContent = visual.icon;
  fragment.querySelector(".widget-label").textContent = widget.label;
  fragment.querySelector(".widget-description").textContent = widget.description;
  fragment.querySelector(".widget-unit").textContent = widget.unit;
  column.hidden = widget.visible === false;
  settingsButton.hidden = !widgetEditingEnabled;
  settingsButton.setAttribute("aria-label", `Uredi ${widget.label}`);
  settingsButton.addEventListener("click", () => openSettingsDialog(widget.id));

  placeWidgetInGroup(widget, column);
  elementsById.set(widget.id, column);
  configById.set(widget.id, widget);
}

function syncWriteOption(widget) {
  let option = [...writeWidget.options].find(
    (candidate) => candidate.value === widget.id
  );
  if (widget.writable !== true) {
    const wasSelected = writeWidget.value === widget.id;
    option?.remove();
    if (wasSelected) configureWriteValueInput({ clear: true });
    updateWritePanel();
    return;
  }

  if (!option) {
    option = document.createElement("option");
    option.value = widget.id;
    writeWidget.appendChild(option);
  }
  option.textContent = widget.label;
  option.hidden = widget.visible === false;
  updateWritePanel();
}

function updateWritePanel() {
  const hasVisibleWritableWidget = [...writeWidget.options]
    .slice(1)
    .some((option) => !option.hidden);
  controlPanel.hidden = !hasVisibleWritableWidget;
}

function selectedWriteValueKind() {
  const current = latestValuesById.get(writeWidget.value)?.widget?.value;
  if (typeof current === "number") return "number";
  if (typeof current === "boolean") return "boolean";
  return "string";
}

function configureWriteValueInput({ clear = false } = {}) {
  const hasSelection = configById.has(writeWidget.value);
  const kind = hasSelection ? selectedWriteValueKind() : "string";

  if (clear) writeValue.value = "";
  writeValue.setCustomValidity("");
  writeValue.dataset.valueKind = kind;
  writeValue.type = kind === "number" ? "number" : "text";
  writeValue.toggleAttribute("step", kind === "number");
  if (kind === "number") writeValue.step = "any";
  writeValue.inputMode = kind === "number" ? "decimal" : "text";
  writeValueLabel.textContent = kind === "string" ? "Novi tekst" : "Nova vrijednost";
  writeValue.placeholder = !hasSelection
    ? "Najprije odaberi widget"
    : kind === "number"
      ? "Upiši broj"
      : kind === "boolean"
        ? "Upiši true ili false"
        : "Upiši tekst";
}

function parseWriteValue() {
  const kind = writeValue.dataset.valueKind || "string";
  const rawValue = writeValue.value;

  if (kind === "number") {
    const numberValue = Number(rawValue);
    return Number.isFinite(numberValue)
      ? { valid: true, value: numberValue }
      : { valid: false, message: "Upiši valjani broj." };
  }

  if (kind === "boolean") {
    const booleanValue = rawValue.trim().toLowerCase();
    if (booleanValue === "true") return { valid: true, value: true };
    if (booleanValue === "false") return { valid: true, value: false };
    return { valid: false, message: "Upiši true ili false." };
  }

  return { valid: true, value: rawValue };
}

function updateEmptyState() {
  if (updatingWidgets) return;
  updateGroups();
  updateClearButton();
  emptyState.hidden = [...configById.values()].some(
    (widget) => widget.visible !== false
  );
  refreshDeviceCards();
}

function setWidgetVisibility(id, visible) {
  const widget = configById.get(id);
  const column = elementsById.get(id);
  if (!widget || !column) return;

  widget.visible = visible;
  column.hidden = !visible;
  const input = visibilityInputsById.get(id);
  if (input) input.checked = visible;

  const writeOption = [...writeWidget.options].find(
    (option) => option.value === id
  );
  if (writeOption) {
    writeOption.hidden = !visible;
    if (!visible && writeWidget.value === id) {
      writeWidget.value = "";
      configureWriteValueInput({ clear: true });
    }
  }

  updateWritePanel();
  updateEmptyState();
}

function showVisibilityStatus(message, state = "") {
  visibilityStatus.className = `discovery-status${state ? ` is-${state}` : ""}`;
  visibilityStatus.textContent = message;
}

async function saveWidgetVisibility(widget, input) {
  const visible = input.checked;
  input.disabled = true;
  showVisibilityStatus(`Spremam prikaz za „${widget.label}”…`);

  try {
    const response = await fetch("/api/widgets/visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: widget.id, visible }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Promjena prikaza nije uspjela (${response.status}).`);
    }

    setWidgetVisibility(widget.id, payload.visible === true);
    showVisibilityStatus("Prikaz dashboarda je spremljen.", "success");
  } catch (error) {
    input.checked = !visible;
    showVisibilityStatus(error.message || "Promjena prikaza nije uspjela.", "error");
  } finally {
    input.disabled = false;
  }
}

function addVisibilityControl(widget) {
  const existingInput = visibilityInputsById.get(widget.id);
  if (existingInput) {
    const item = existingInput.closest(".visibility-item");
    item.querySelector(".visibility-name").textContent = widget.label;
    existingInput.checked = widget.visible !== false;
    existingInput.setAttribute("aria-label", `Prikaži ${widget.label}`);
    return;
  }

  const fragment = visibilityItemTemplate.content.cloneNode(true);
  const item = fragment.querySelector(".visibility-item");
  const input = fragment.querySelector(".visibility-checkbox");
  item.dataset.widgetId = widget.id;
  fragment.querySelector(".visibility-name").textContent = widget.label;
  fragment.querySelector(".visibility-id").textContent = widget.id;
  input.checked = widget.visible !== false;
  input.setAttribute("aria-label", `Prikaži ${widget.label}`);
  input.addEventListener("change", () => {
    void saveWidgetVisibility(widget, input);
  });

  visibilityList.appendChild(fragment);
  visibilityInputsById.set(widget.id, input);
}

function applyConfiguredWidget(widget) {
  if (!widget || typeof widget.id !== "string") return;
  updateTreeValue(widget.id, true);

  const current = configById.get(widget.id);
  if (!current) {
    createWidget(widget);
    syncWriteOption(widget);
    addVisibilityControl(widget);
    updateEmptyState();
    refreshDiscoveryItems();
    return;
  }

  const previousGroup = widgetGroupName(current);
  Object.assign(current, widget);
  if (settingsDialog.open && settingsId.value === current.id && widgetGroupName(current) !== previousGroup) {
    if (settingsGroup.value.trim() === previousGroup) settingsGroup.value = widgetGroupName(current);
    else showSettingsStatus(`Grupa je u međuvremenu preimenovana u „${widgetGroupName(current)}”. Spremanje će primijeniti naziv koji si upisao.`, "error");
  }
  const column = elementsById.get(widget.id);
  placeWidgetInGroup(current, column);
  const card = column.querySelector(".widget-card");
  const visual = visualForUnit(current.unit);
  card.style.setProperty("--widget-color", visual.color);
  card.style.setProperty("--widget-soft", visual.soft);
  column.querySelector(".widget-icon").textContent = visual.icon;
  column.querySelector(".widget-label").textContent = current.label;
  column.querySelector(".widget-description").textContent = current.description;
  column.querySelector(".widget-unit").textContent = current.unit;
  column
    .querySelector(".widget-settings-button")
    .setAttribute("aria-label", `Uredi ${current.label}`);

  syncWriteOption(current);
  addVisibilityControl(current);
  setWidgetVisibility(current.id, current.visible !== false);

  const latest = latestValuesById.get(current.id);
  if (latest) updateWidget(latest.widget, latest.syncedAt);
  refreshDiscoveryItems();
}

function removeConfiguredWidget(id) {
  updateTreeValue(id, false);
  elementsById.get(id)?.remove();
  elementsById.delete(id);
  configById.delete(id);
  groupByWidgetId.delete(id);
  if (configById.size === 0) showStatus({ state: "idle" });
  latestValuesById.delete(id);
  visibilityInputsById.get(id)?.closest(".visibility-item")?.remove();
  visibilityInputsById.delete(id);
  const wasSelected = writeWidget.value === id;
  [...writeWidget.options].find((option) => option.value === id)?.remove();
  if (wasSelected) configureWriteValueInput({ clear: true });
  if (settingsDialog.open && settingsId.value === id) settingsDialog.close();
  updateWritePanel();
  updateEmptyState();
  refreshDiscoveryItems();
}

function reconcileSnapshot(payload) {
  const widgets = Array.isArray(payload.widgets) ? payload.widgets : [];
  const ids = new Set(widgets.map((widget) => widget.id));
  removeConfiguredWidgets([...configById.keys()].filter((id) => !ids.has(id)));
  applyConfiguredWidgets(widgets);
  applyPayload(payload);
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

  latestValuesById.set(widget.id, { widget: { ...widget }, syncedAt });

  const config = configById.get(widget.id) || {};
  const card = column.querySelector(".widget-card");
  const state = column.querySelector(".widget-state");

  const valueElement = column.querySelector(".widget-value");
  const formattedValue = formatValue(widget.value, config.precision);
  const numericValue = Number(widget.value);
  const isTextValue =
    widget.value !== null &&
    widget.value !== undefined &&
    String(widget.value).trim() !== "" &&
    !Number.isFinite(numericValue);

  valueElement.textContent = formattedValue;
  valueElement.title = formattedValue === "—" ? "" : formattedValue;
  valueElement.classList.toggle("is-text", isTextValue);
  column
    .querySelector(".widget-reading")
    .classList.toggle("has-text-value", isTextValue);
  if (writeWidget.value === widget.id) configureWriteValueInput();
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
  deviceConnectionStatus = state;
  const isOnline = state === "connected" || state === "online";
  const isOffline = state === "error" || state === "offline";
  const isEmpty = state === "idle" && configById.size === 0;

  connectionDot.className = `connection-dot ${
    isOnline ? "is-online" : isOffline ? "is-offline" : isEmpty ? "" : "is-connecting"
  }`;
  connectionLabel.textContent = isOnline
    ? "Podaci uživo"
    : isOffline
      ? "Veza prekinuta"
      : isEmpty ? "Nema konfiguriranih točaka" : "Povezivanje…";

  if (isEmpty) lastSync.textContent = "Dodaj vrijednost kroz pretragu za početak praćenja";

  errorBanner.hidden = !isOffline;
  if (isOffline) {
    errorMessage.textContent =
      status.error || status.message || "Servis će pokušati ponovno.";
  }
  refreshDeviceCards();
}

function applyPayload(payload = {}) {
  const widgets = payload.widgets || payload.changed || [];
  for (const widget of widgets) updateWidget(widget, payload.syncedAt);

  const syncTime = payload.syncedAt || payload.lastSync;
  if (syncTime) {
    deviceReadAt = syncTime;
    lastSync.textContent = `Zadnja uspješna provjera: ${formatTime(syncTime)}`;
  }
  if (payload.status) showStatus(payload);
  refreshDeviceCards();
}

function setupWriteControls(widgets) {
  controlPanel.hidden = true;
  widgets.forEach(syncWriteOption);
}

function setupVisibilityControls(widgets) {
  visibilityList.replaceChildren();
  visibilityInputsById.clear();
  widgets.forEach(addVisibilityControl);
}

function setDiscoveryBusy(busy) {
  discoveryQuery.disabled = busy;
  discoverySearch.disabled = busy;
  discoverySearch.classList.toggle("is-loading", busy);
}

function showDiscoveryStatus(message, state = "") {
  discoveryStatus.className = `discovery-status${state ? ` is-${state}` : ""}`;
  discoveryStatus.textContent = message;
}

async function addDiscoveredWidget(item, button) {
  button.disabled = true;
  button.textContent = "Dodajem…";

  try {
    const response = await fetch("/api/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Dodavanje nije uspjelo (${response.status}).`);
    }

    applyConfiguredWidget(payload.widget);
    item.alreadyAdded = true;
    button.textContent = "Dodano";
    showDiscoveryStatus(`„${item.name}” je dodan u widgets.json i na dashboard.`, "success");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Dodaj";
    showDiscoveryStatus(error.message || "Dodavanje widgeta nije uspjelo.", "error");
  }
}

function renderDiscoveryItems(payload) {
  lastDiscoveryPayload = payload;
  discoveryResults.replaceChildren();
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "discovery-empty";
    empty.textContent = "Nema pronađenih containera ili vrijednosti za ovaj ID.";
    discoveryResults.appendChild(empty);
    return;
  }

  for (const item of items) {
    if (item.kind === "value") item.alreadyAdded = configById.has(item.id);
    const fragment = discoveryItemTemplate.content.cloneNode(true);
    const article = fragment.querySelector(".discovery-item");
    const kind = fragment.querySelector(".discovery-kind");
    const action = fragment.querySelector(".discovery-action");

    article.dataset.objectId = item.id;
    kind.textContent = item.kind === "container" ? "Container" : "Vrijednost";
    kind.classList.toggle("is-value", item.kind === "value");
    fragment.querySelector(".discovery-name").textContent = item.name;
    fragment.querySelector(".discovery-id").textContent = item.id;

    const details = [
      item.description,
      item.type,
      item.unit,
      item.controllerWritable ? "Kontroler podržava upis" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    fragment.querySelector(".discovery-item-description").textContent = details;

    if (item.kind === "container") {
      action.textContent = "Otvori";
      action.addEventListener("click", () => {
        discoveryQuery.value = item.id;
        discoveryForm.requestSubmit();
      });
    } else if (item.alreadyAdded) {
      action.textContent = "Već dodano";
      action.disabled = true;
    } else if (!widgetEditingEnabled || payload.canAdd !== true) {
      action.textContent = "Samo pregled";
      action.disabled = true;
      action.title = "Za spremanje je potreban zapisivi WIDGETS_FILE.";
    } else {
      action.textContent = "Dodaj";
      action.addEventListener("click", () => addDiscoveredWidget(item, action));
    }

    discoveryResults.appendChild(fragment);
  }
}

function refreshDiscoveryItems() {
  if (updatingWidgets) return;
  if (lastDiscoveryPayload && discoveryDialog.open) renderDiscoveryItems(lastDiscoveryPayload);
}

async function searchObjects() {
  setDiscoveryBusy(true);
  lastDiscoveryPayload = null;
  discoveryResults.replaceChildren();
  showDiscoveryStatus("Dohvaćam objekte iz middlewarea…");

  try {
    const response = await fetch("/api/discovery/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: discoveryQuery.value.trim() }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Pretraga nije uspjela (${response.status}).`);
    }

    renderDiscoveryItems(payload);
    const suffix = payload.truncated ? " Prikazano je prvih 500 rezultata." : "";
    const discoveryErrors = Array.isArray(payload.errors) ? payload.errors : [];
    if (discoveryErrors.length > 0 && payload.items.length === 0) {
      showDiscoveryStatus(discoveryErrors[0].message, "error");
    } else {
      showDiscoveryStatus(
        `Pronađeno: ${payload.items.length}.${suffix}`,
        payload.items.length > 0 ? "success" : ""
      );
    }
  } catch (error) {
    showDiscoveryStatus(error.message || "Pretraga objekata nije uspjela.", "error");
  } finally {
    setDiscoveryBusy(false);
  }
}

function applyConfiguredWidgets(widgets, groupRename = null) {
  const previousGroup = groupsByName.get(groupRename?.from);
  const previousOpen = previousGroup?.section.open;
  const selectedGroupRenamed = previousGroup && widgetsGroupSelect.value === groupRename.from;
  updatingWidgets = true;
  try {
    widgets.forEach(applyConfiguredWidget);
  } finally {
    updatingWidgets = false;
    if (previousOpen !== undefined && groupRename.from !== groupRename.to) {
      const renamedGroup = groupsByName.get(groupRename.to);
      if (renamedGroup) renamedGroup.section.open = previousOpen;
    }
    updateEmptyState();
    if (selectedGroupRenamed) {
      widgetsGroupSelect.value = groupRename.to;
      updateClearButton();
    }
    refreshDiscoveryItems();
    scheduleDeviceMetadataRefresh();
  }
}

function updateTreeValue(id, added) {
  const badge = treeValuesById.get(id);
  if (badge) badge.textContent = added ? "Na dashboardu" : "Nije na dashboardu";
}

function renderDiscoveryTree(nodes) {
  discoveryTree.replaceChildren();
  treeValuesById.clear();
  const childLists = new Map();
  const fragment = document.createDocumentFragment();
  // The scan returns parents before their children, so even deep trees need no recursion.
  for (const node of nodes) {
    const entry = document.createElement("li");
    if (node.kind === "container") {
      const folder = document.createElement("details");
      folder.open = node.parentId === null || Boolean(node.error);
      const title = document.createElement("summary");
      title.textContent = `📁 ${node.name}${node.error ? " ⚠" : ""}`;
      title.title = node.id || "EWS root";
      const children = document.createElement("ul");
      folder.appendChild(title);
      if (node.error) {
        const warning = document.createElement("p");
        warning.className = "tree-warning";
        warning.textContent = `Nije u potpunosti pročitano: ${node.error}`;
        folder.appendChild(warning);
      }
      folder.appendChild(children);
      entry.appendChild(folder);
      childLists.set(node.id, children);
    } else {
      entry.className = "tree-value";
      const title = document.createElement("span");
      title.textContent = `◇ ${node.name}${node.unit ? ` (${node.unit})` : ""}`;
      const badge = document.createElement("span");
      badge.className = "tree-added";
      treeValuesById.set(node.id, badge);
      updateTreeValue(node.id, configById.has(node.id));
      const id = document.createElement("span");
      id.className = "tree-id";
      id.textContent = node.id;
      entry.append(title, badge, id);
    }
    if (node.parentId === null) {
      const root = document.createElement("ul");
      root.appendChild(entry);
      fragment.appendChild(root);
    } else {
      childLists.get(node.parentId)?.appendChild(entry);
    }
  }
  discoveryTree.appendChild(fragment);
  discoveryTree.hidden = false;
}

function showAutomaticDiscovery(payload) {
  const warningCount = payload.failedBranches || 0;
  automaticDiscoveryRunning = payload.state === "running";
  discoveryAuto.disabled = automaticDiscoveryRunning || widgetClearBusy || !widgetEditingEnabled;
  updateClearButton();
  discoveryAuto.textContent = automaticDiscoveryRunning ? "Automatsko dodavanje u tijeku…" : "Automatski dodaj sve vrijednosti";
  discoveryAutoStatus.className = `discovery-status${payload.state === "error" ? " is-error" : warningCount > 0 ? " is-warning" : payload.state === "done" ? " is-success" : ""}`;
  if (automaticDiscoveryRunning) {
    discoveryTree.hidden = true;
    discoveryAutoStatus.textContent = payload.phase === "saving"
      ? `Spremam pronađene vrijednosti: ${payload.found}.`
      : `Pregledano mapa: ${payload.containers}. Pronađeno vrijednosti: ${payload.found}. Preostalo mapa: ${payload.pending}.`;
    if (warningCount > 0) discoveryAutoStatus.textContent += ` Grane s upozorenjem: ${warningCount}.`;
  } else if (payload.state === "done") {
    if (Array.isArray(payload.tree)) renderDiscoveryTree(payload.tree);
    discoveryAutoStatus.textContent = `Dodano: ${payload.added}. Već postojeće: ${payload.skipped}. Pregledano mapa: ${payload.containers}.`;
    if (warningCount > 0) discoveryAutoStatus.textContent += ` Grane s upozorenjem: ${warningCount}. Otvori označene mape u stablu za detalje.`;
  } else if (payload.state === "error") {
    discoveryAutoStatus.textContent = payload.error;
  }
}

discoveryAuto.addEventListener("click", async () => {
  if (automaticDiscoveryRunning || widgetClearBusy) return;
  showAutomaticDiscovery({ state: "running", containers: 0, found: 0, pending: 1 });
  try {
    const response = await fetch("/api/discovery/auto", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload.code === "DISCOVERY_IN_PROGRESS") {
      const statusResponse = await fetch("/api/discovery/auto", { cache: "no-store" });
      if (!statusResponse.ok) throw new Error("Status automatskog dodavanja nije dostupan.");
      showAutomaticDiscovery(await statusResponse.json());
    } else if (!response.ok) {
      throw new Error(payload.error || "Automatsko dodavanje nije uspjelo.");
    }
    // Progress and completion arrive through SSE, including after reconnecting.
  } catch (error) {
    showAutomaticDiscovery({ state: "error", error: error.message });
  }
});

discoveryOpen.addEventListener("click", () => {
  discoveryDialog.showModal();
  requestAnimationFrame(() => discoveryQuery.focus());
});

discoveryClose.addEventListener("click", () => discoveryDialog.close());
discoveryDialog.addEventListener("click", (event) => {
  if (event.target === discoveryDialog) discoveryDialog.close();
});
discoveryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void searchObjects();
});

visibilityOpen.addEventListener("click", () => {
  showVisibilityStatus("");
  if (!widgetClearBusy) {
    widgetsClearConfirmation.hidden = true;
    widgetsClearStatus.textContent = "";
  }
  updateClearButton();
  visibilityDialog.showModal();
});

visibilityClose.addEventListener("click", () => { if (!widgetClearBusy) visibilityDialog.close(); });
visibilityDialog.addEventListener("click", (event) => {
  if (event.target === visibilityDialog && !widgetClearBusy) visibilityDialog.close();
});
visibilityDialog.addEventListener("cancel", (event) => {
  if (widgetClearBusy) event.preventDefault();
});

function removeConfiguredWidgets(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  updatingWidgets = true;
  try {
    ids.forEach(removeConfiguredWidget);
  } finally {
    updatingWidgets = false;
    updateEmptyState();
    refreshDiscoveryItems();
  }
}

function setWidgetClearBusy(busy) {
  widgetClearBusy = busy;
  visibilityClose.disabled = busy;
  widgetsClearConfirm.disabled = busy;
  widgetsClearCancel.disabled = busy;
  groupClearClose.disabled = busy;
  groupClearCancel.disabled = busy;
  groupRenameClose.disabled = busy;
  groupRenameCancel.disabled = busy;
  groupRenameName.disabled = busy;
  for (const input of visibilityInputsById.values()) input.disabled = busy;
  discoveryAuto.disabled = busy || automaticDiscoveryRunning || !widgetEditingEnabled;
  updateClearButton();
}

widgetsClear.addEventListener("click", () => {
  if (widgetClearBusy || automaticDiscoveryRunning || configById.size === 0) return;
  widgetsClearMessage.textContent = `Obrisati sve widgete s dashboarda (${configById.size})?`;
  widgetsClearConfirmation.hidden = false;
  widgetsClearCancel.focus();
});
widgetsClearCancel.addEventListener("click", () => {
  widgetsClearConfirmation.hidden = true;
  widgetsClear.focus();
});
widgetsClearConfirm.addEventListener("click", async () => {
  if (widgetClearBusy || widgetsClearConfirmation.hidden) return;
  let removed = false;
  setWidgetClearBusy(true);
  widgetsClearStatus.className = "discovery-status";
  widgetsClearStatus.textContent = "Brišem sve widgete…";
  try {
    const response = await fetch("/api/widgets/all", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Brisanje nije uspjelo (${response.status}).`);
    removeConfiguredWidgets(payload.ids);
    widgetsClearConfirmation.hidden = true;
    widgetsClearStatus.className = "discovery-status is-success";
    widgetsClearStatus.textContent = "Svi widgeti su uklonjeni. Nove vrijednosti možeš dodati kroz discovery.";
    removed = true;
  } catch (error) {
    widgetsClearStatus.className = "discovery-status is-error";
    widgetsClearStatus.textContent = error.message || "Brisanje widgeta nije uspjelo.";
  } finally {
    setWidgetClearBusy(false);
    if (removed) visibilityClose.focus();
  }
});

function openGroupClearDialog(name) {
  if (widgetClearBusy || automaticDiscoveryRunning || !groupsByName.has(name)) return;
  groupClearTarget = name;
  groupClearStatus.textContent = "";
  groupClearDialog.showModal();
  updateClearButton();
  groupClearCancel.focus();
}

function closeGroupClearDialog() {
  if (widgetClearBusy) return;
  groupClearDialog.close();
  if (visibilityDialog.open) widgetsGroupSelect.focus();
  else visibilityOpen.focus();
}

widgetsGroupSelect.addEventListener("change", updateClearButton);
widgetsGroupClear.addEventListener("click", () => openGroupClearDialog(widgetsGroupSelect.value));
groupClearClose.addEventListener("click", closeGroupClearDialog);
groupClearCancel.addEventListener("click", closeGroupClearDialog);
groupClearDialog.addEventListener("click", (event) => {
  if (event.target === groupClearDialog) closeGroupClearDialog();
});
groupClearDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeGroupClearDialog();
});
groupClearConfirm.addEventListener("click", async () => {
  if (widgetClearBusy || automaticDiscoveryRunning || !groupsByName.has(groupClearTarget)) return;
  let removed = false;
  setWidgetClearBusy(true);
  groupClearStatus.className = "discovery-status";
  groupClearStatus.textContent = "Brišem grupu…";
  try {
    const response = await fetch("/api/widgets/group", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: groupClearTarget }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Brisanje nije uspjelo (${response.status}).`);
    removeConfiguredWidgets(payload.ids);
    groupClearDialog.close();
    if (visibilityDialog.open) {
      widgetsClearStatus.className = "discovery-status is-success";
      widgetsClearStatus.textContent = `Grupa „${groupClearTarget}” je uklonjena.`;
    }
    removed = true;
  } catch (error) {
    groupClearStatus.className = "discovery-status is-error";
    groupClearStatus.textContent = error.message || "Brisanje grupe nije uspjelo.";
  } finally {
    setWidgetClearBusy(false);
    if (removed) {
      if (visibilityDialog.open) widgetsGroupSelect.focus();
      else visibilityOpen.focus();
    }
  }
});

function focusGroupControl(name) {
  if (visibilityDialog.open) widgetsGroupSelect.focus();
  else if (groupsByName.has(name)) groupsByName.get(name).rename.focus();
  else visibilityOpen.focus();
}

function openGroupRenameDialog(name) {
  if (widgetClearBusy || automaticDiscoveryRunning || !widgetEditingEnabled || !groupsByName.has(name)) return;
  groupRenameTarget = name;
  groupRenameName.value = name;
  groupRenameName.setCustomValidity("");
  groupRenameStatus.textContent = "";
  groupRenameDialog.showModal();
  updateClearButton();
  groupRenameName.focus();
  groupRenameName.select();
}

function closeGroupRenameDialog() {
  if (widgetClearBusy) return;
  groupRenameDialog.close();
  focusGroupControl(groupRenameTarget);
}

widgetsGroupRename.addEventListener("click", () => openGroupRenameDialog(widgetsGroupSelect.value));
groupRenameClose.addEventListener("click", closeGroupRenameDialog);
groupRenameCancel.addEventListener("click", closeGroupRenameDialog);
groupRenameDialog.addEventListener("click", (event) => {
  if (event.target === groupRenameDialog) closeGroupRenameDialog();
});
groupRenameDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeGroupRenameDialog();
});
groupRenameName.addEventListener("input", () => groupRenameName.setCustomValidity(""));
groupRenameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (widgetClearBusy || automaticDiscoveryRunning || !groupsByName.has(groupRenameTarget)) return;
  const name = groupRenameName.value.trim();
  groupRenameName.setCustomValidity(name ? "" : "Upiši naziv grupe.");
  if (!groupRenameForm.reportValidity()) return;
  let renamed = false;
  setWidgetClearBusy(true);
  groupRenameStatus.className = "discovery-status";
  groupRenameStatus.textContent = "Spremam naziv grupe…";
  try {
    const response = await fetch("/api/widgets/group", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: groupRenameTarget, name }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.code === "WIDGET_GROUP_EXISTS" ? "Grupa s tim nazivom već postoji. Odaberi drugi naziv." : payload.error || `Preimenovanje nije uspjelo (${response.status}).`);
    }
    applyConfiguredWidgets(payload.widgets, { from: payload.group, to: payload.name });
    groupRenameTarget = payload.name;
    widgetsGroupSelect.value = payload.name;
    groupRenameDialog.close();
    if (visibilityDialog.open) {
      widgetsClearStatus.className = "discovery-status is-success";
      widgetsClearStatus.textContent = `Naziv grupe je spremljen: „${payload.name}”.`;
    }
    renamed = true;
  } catch (error) {
    groupRenameStatus.className = "discovery-status is-error";
    groupRenameStatus.textContent = error.message || "Preimenovanje grupe nije uspjelo.";
  } finally {
    setWidgetClearBusy(false);
    if (renamed) focusGroupControl(groupRenameTarget);
  }
});

function showCardSettingsStatus(message, state = "") {
  cardSettings.status.className = `discovery-status${state ? ` is-${state}` : ""}`;
  cardSettings.status.textContent = message;
}

function cardSettingsDevices() {
  return deviceCardView?.getDevices?.() || [];
}

function metricChoicesForDevice(device) {
  const owners = new Map(cardSettingsDevices().map((entry) => [entry.key, entry.label]));
  const choices = [];
  for (const widget of configById.values()) {
    if (widget.visible === false) continue;
    const owner = globalThis.IoTWidgetGrouping.deriveWidgetGrouping(widget.id);
    const point = globalThis.IoTDeviceModel.normalizePoint(widget, deviceMetadata.metadataById[widget.id] || {});
    const title = point.role === "unknown" ? widget.label : point.label;
    const reference = widget.id.startsWith("11/") ? " · referenca" : "";
    const ownerLabel = owners.get(owner.key) || owner.label;
    choices.push({ id: widget.id, title, owner: ownerLabel, label: `${title} · ${ownerLabel}${reference}`, related: owner.key === device.key });
  }
  choices.sort((left, right) => Number(right.related) - Number(left.related) || left.label.localeCompare(right.label, "hr"));
  return choices;
}

function appendSettingsOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function effectiveCardPrimaryId() {
  return cardSettings.primary.value === "auto" ? cardSettingsContext?.device.defaultMetrics?.primaryPointId : cardSettings.primary.value;
}

function renderCardSecondaryChoices() {
  if (!cardSettingsContext) return;
  const { choices, secondaryIds } = cardSettingsContext;
  const relatedIds = new Set(choices.filter((choice) => choice.related).map((choice) => choice.id));
  for (const id of secondaryIds) if (!relatedIds.has(id)) secondaryIds.delete(id);
  const primaryId = effectiveCardPrimaryId();
  if (primaryId) secondaryIds.delete(primaryId);
  const query = cardSettings.search.value.trim().toLocaleLowerCase("hr");
  cardSettings["secondary-list"].replaceChildren();
  let count = 0;
  for (const choice of choices) {
    if (!choice.related) continue;
    if (query && !`${choice.label} ${choice.id}`.toLocaleLowerCase("hr").includes(query)) continue;
    const label = document.createElement("label");
    label.className = "device-metric-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "browser-default";
    checkbox.value = choice.id;
    checkbox.checked = secondaryIds.has(choice.id);
    checkbox.disabled = cardSettingsBusy || choice.id === primaryId;
    checkbox.setAttribute("aria-label", choice.label);
    checkbox.addEventListener("change", () => {
      if (cardSettingsBusy) return;
      if (checkbox.checked && secondaryIds.size >= 12) {
        checkbox.checked = false;
        showCardSettingsStatus("Odaberi najviše 12 sekundarnih očitanja.", "error");
        return;
      }
      if (checkbox.checked) secondaryIds.add(choice.id);
      else secondaryIds.delete(choice.id);
      cardSettings["secondary-count"].textContent = `${secondaryIds.size} / 12 odabranih · Redoslijed prati odabir.`;
      showCardSettingsStatus("");
    });
    const copy = document.createElement("span");
    copy.textContent = choice.title;
    const source = document.createElement("small");
    source.textContent = `${choice.owner}${choice.missing ? " · nije dostupno" : ""}${choice.id.startsWith("11/") ? " · referenca" : ""}`;
    copy.appendChild(source);
    label.append(checkbox, copy);
    cardSettings["secondary-list"].appendChild(label);
    count++;
  }
  if (!count) {
    const empty = document.createElement("p");
    empty.className = "settings-context";
    empty.textContent = "Nema očitanja za taj upit.";
    cardSettings["secondary-list"].appendChild(empty);
  }
  cardSettings["secondary-count"].textContent = `${secondaryIds.size} / 12 odabranih · Redoslijed prati odabir.`;
}

function updateCardSecondaryMode() {
  cardSettings["secondary-field"].hidden = cardSettings["secondary-mode"].value !== "custom";
  renderCardSecondaryChoices();
}

function updateCardUnitMode() {
  const custom = cardSettings["unit-mode"].value === "custom";
  cardSettings["unit-field"].hidden = !custom;
  cardSettings.unit.required = custom;
  cardSettings.unit.setCustomValidity("");
  cardSettings["unit-hint"].textContent = "Jedinica vrijedi za glavno očitanje. Mijenja oznaku, bez preračunavanja vrijednosti.";
}

function updateCardAutomaticUnit() {
  if (!cardSettingsContext) return;
  const [device] = globalThis.IoTDeviceModel.buildDevices([...configById.values()], {
    ...deviceMetadata,
    deviceSettings: [{ key: cardSettingsContext.key, primaryPointId: cardSettings.primary.value === "auto" ? null : cardSettings.primary.value }],
  }).filter((entry) => entry.key === cardSettingsContext.key);
  const automaticUnit = device?.primaryAutomaticUnit || "";
  const option = [...cardSettings["unit-mode"].options].find((entry) => entry.value === "auto");
  if (option) option.textContent = `Automatski · ${automaticUnit || "bez jedinice"}`;
}

function updateCardRoomMode() {
  const custom = cardSettings.room.value === "new";
  cardSettings["new-room-field"].hidden = !custom;
  cardSettings["new-room"].required = custom;
  cardSettings["new-room"].setCustomValidity("");
}

function populateCardSettings(entry) {
  const { device } = cardSettingsContext;
  const automaticLabel = device.automaticLabel || device.label;
  cardSettings.label.value = entry?.label || "";
  cardSettings.label.placeholder = automaticLabel;
  cardSettings["label-hint"].textContent = `Prazno polje koristi automatski naziv: ${automaticLabel}.`;
  cardSettings.room.replaceChildren();
  appendSettingsOption(cardSettings.room, "auto", `Automatski · ${device.automaticRoom?.label || "Bez prostorije"}`);
  appendSettingsOption(cardSettings.room, "unassigned", "Bez prostorije");
  const rooms = new Set();
  for (const candidate of cardSettingsDevices()) {
    if (candidate.room?.label) rooms.add(candidate.room.label);
    if (candidate.automaticRoom?.label) rooms.add(candidate.automaticRoom.label);
  }
  for (const saved of deviceSettingsByKey.values()) if (saved.room) rooms.add(saved.room);
  if (entry?.room) rooms.add(entry.room);
  for (const room of [...rooms].sort((a, b) => a.localeCompare(b, "hr"))) appendSettingsOption(cardSettings.room, `room:${room}`, room);
  appendSettingsOption(cardSettings.room, "new", "Nova prostorija…");
  cardSettings.room.value = entry?.room === "" ? "unassigned" : entry?.room ? `room:${entry.room}` : "auto";
  cardSettings["new-room"].value = "";
  updateCardRoomMode();

  const choices = metricChoicesForDevice(device);
  const configuredIds = new Set(choices.map((choice) => choice.id));
  for (const id of [entry?.primaryPointId, ...(entry?.secondaryPointIds || [])]) {
    if (!id || configuredIds.has(id)) continue;
    const related = globalThis.IoTWidgetGrouping.deriveWidgetGrouping(id).key === device.key;
    choices.push({ id, title: "Nedostupna točka", owner: id, label: `Nedostupna točka · ${id}`, missing: true, related });
    configuredIds.add(id);
  }
  cardSettingsContext.choices = choices;
  cardSettings.primary.replaceChildren();
  const defaultPrimaryId = device.defaultMetrics?.primaryPointId;
  const defaultPrimary = choices.find((choice) => choice.id === defaultPrimaryId);
  appendSettingsOption(cardSettings.primary, "auto", `Automatski${defaultPrimary ? ` · ${defaultPrimary.title}` : ""}`);
  for (const choice of choices) appendSettingsOption(cardSettings.primary, choice.id, choice.label);
  cardSettings.primary.value = entry?.primaryPointId || "auto";
  const primaryUnit = typeof entry?.primaryUnit === "string" ? entry.primaryUnit : null;
  cardSettings["unit-mode"].replaceChildren();
  appendSettingsOption(cardSettings["unit-mode"], "auto", "Automatski");
  appendSettingsOption(cardSettings["unit-mode"], "none", "Bez jedinice");
  appendSettingsOption(cardSettings["unit-mode"], "custom", "Vlastita jedinica");
  cardSettings["unit-mode"].value = primaryUnit === null ? "auto" : primaryUnit === "" ? "none" : "custom";
  cardSettings.unit.value = primaryUnit || "";
  updateCardAutomaticUnit();
  updateCardUnitMode();
  cardSettings["secondary-mode"].value = Array.isArray(entry?.secondaryPointIds) ? "custom" : "auto";
  const defaults = device.defaultMetrics?.secondaryPointIds || [];
  cardSettingsContext.secondaryIds = new Set(entry?.secondaryPointIds || defaults);
  const defaultLabels = defaults.map((id) => choices.find((choice) => choice.id === id)?.title).filter(Boolean);
  cardSettings["secondary-hint"].textContent = defaultLabels.length ? `Automatski: ${defaultLabels.join(", ")}.` : "Automatski: bez dodatnih očitanja.";
  cardSettings.search.value = "";
  updateCardSecondaryMode();
  cardSettings.functions.disabled = !widgetEditingEnabled;
}

function openDeviceCardSettingsDialog(device) {
  if (!device || cardSettingsBusy || widgetClearBusy) return;
  if (!deviceSettingsEnabled) {
    openDeviceSettingsDialog(device);
    return;
  }
  cardSettingsContext = { key: device.key, device, secondaryIds: new Set(), choices: [] };
  cardSettings.title.textContent = `Postavke kartice ${device.label}`;
  populateCardSettings(deviceSettingsByKey.get(device.key));
  showCardSettingsStatus("");
  if (!cardSettings.dialog.open) cardSettings.dialog.showModal();
  requestAnimationFrame(() => cardSettings.label.focus());
}

function setCardSettingsBusy(busy) {
  cardSettingsBusy = busy;
  for (const element of cardSettings.form.elements) element.disabled = busy;
  cardSettings.close.disabled = busy;
  cardSettings.functions.disabled = busy || !widgetEditingEnabled;
  renderCardSecondaryChoices();
}

cardSettings.room.addEventListener("change", updateCardRoomMode);
cardSettings.primary.addEventListener("change", () => {
  renderCardSecondaryChoices();
  updateCardAutomaticUnit();
});
cardSettings["unit-mode"].addEventListener("change", updateCardUnitMode);
cardSettings["secondary-mode"].addEventListener("change", updateCardSecondaryMode);
cardSettings.search.addEventListener("input", renderCardSecondaryChoices);
cardSettings.close.addEventListener("click", () => { if (!cardSettingsBusy) cardSettings.dialog.close(); });
cardSettings.cancel.addEventListener("click", () => { if (!cardSettingsBusy) cardSettings.dialog.close(); });
cardSettings.dialog.addEventListener("click", (event) => {
  if (event.target === cardSettings.dialog && !cardSettingsBusy) cardSettings.dialog.close();
});
cardSettings.dialog.addEventListener("cancel", (event) => { if (cardSettingsBusy) event.preventDefault(); });
cardSettings.reset.addEventListener("click", () => {
  if (!cardSettingsContext || cardSettingsBusy) return;
  populateCardSettings(null);
  showCardSettingsStatus("Automatski naziv, prostorija, očitanja i jedinica su odabrani. Spremi karticu za potvrdu.");
});
cardSettings.functions.addEventListener("click", () => {
  if (!cardSettingsContext || cardSettingsBusy) return;
  const current = cardSettingsDevices().find((device) => device.key === cardSettingsContext.key) || cardSettingsContext.device;
  openDeviceSettingsDialog(current);
});
cardSettings.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cardSettingsContext || cardSettingsBusy || !deviceSettingsEnabled) return;
  const newRoom = cardSettings["new-room"].value.trim();
  const needsRoom = cardSettings.room.value === "new";
  const customUnit = cardSettings["unit-mode"].value === "custom";
  const unit = cardSettings.unit.value.trim();
  const invalidUnit = customUnit && (!unit || unit.length > 40);
  cardSettings.unit.setCustomValidity(invalidUnit ? "Upiši mjernu jedinicu do 40 znakova ili odaberi Bez jedinice." : "");
  cardSettings["new-room"].setCustomValidity(needsRoom && !newRoom ? "Upiši naziv nove prostorije." : "");
  if (!cardSettings.form.reportValidity() || needsRoom && !newRoom || invalidUnit) return;
  const room = cardSettings.room.value === "auto" ? null
    : cardSettings.room.value === "unassigned" ? ""
      : needsRoom ? newRoom : cardSettings.room.value.slice(5);
  const primaryPointId = cardSettings.primary.value === "auto" ? null : cardSettings.primary.value;
  const secondaryPointIds = cardSettings["secondary-mode"].value === "auto" ? null
    : [...cardSettingsContext.secondaryIds].filter((id) => id !== effectiveCardPrimaryId()
      && globalThis.IoTWidgetGrouping.deriveWidgetGrouping(id).key === cardSettingsContext.key);
  const primaryUnit = cardSettings["unit-mode"].value === "auto" ? null : customUnit ? unit : "";
  const settings = { key: cardSettingsContext.key, label: cardSettings.label.value.trim() || null, room, primaryPointId, primaryUnit, secondaryPointIds };
  // Older reconnect reads must not replace the result of this user save.
  const saveRequest = ++deviceSettingsRequest;
  setCardSettingsBusy(true);
  showCardSettingsStatus("Spremam postavke kartice…");
  try {
    const response = await fetch("/api/devices/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Spremanje nije uspjelo (${response.status}).`);
    if (payload.device?.key !== settings.key) throw new Error("Potvrda spremanja ne odgovara odabranoj kartici.");
    if (saveRequest === deviceSettingsRequest) {
      deviceSettingsByKey.set(payload.device.key, payload.device);
      deviceSettingsWarning = "";
      refreshDeviceCards();
    } else {
      // Another settings event/read happened while the POST was in flight.
      // Reconcile with storage instead of overwriting it with this older response.
      await refreshSavedDeviceSettings();
    }
    const current = cardSettingsDevices().find((device) => device.key === settings.key);
    if (current) {
      cardSettingsContext.device = current;
      cardSettings.title.textContent = `Postavke kartice ${current.label}`;
    }
    showCardSettingsStatus("Naziv, prostorija, očitanja i jedinica kartice su spremljeni.", "success");
  } catch (error) {
    showCardSettingsStatus(error.message || "Postavke kartice nisu spremljene.", "error");
  } finally {
    setCardSettingsBusy(false);
  }
});

function showSettingsStatus(message, state = "") {
  settingsStatus.className = `discovery-status${state ? ` is-${state}` : ""}`;
  settingsStatus.textContent = message;
}

function populateSettingsForm(widget) {
  settingsForm.reset();
  settingsPoint.value = widget.id;
  settingsId.value = widget.id;
  settingsLabel.value = widget.label;
  settingsDescription.value = widget.description;
  settingsGroup.value = widget.group || "";
  settingsGroup.placeholder = deriveWidgetGroup(widget.id);
  settingsUnit.value = widget.unit;
  settingsPrecision.value = Number.isInteger(widget.precision)
    ? String(widget.precision)
    : "";
  settingsWritable.checked = widget.writable === true;
  settingsVisible.checked = widget.visible !== false;
  settingsPrecision.setCustomValidity("");
  showSettingsStatus("");
  settingsDeleteConfirmation.hidden = true;
  updateSettingsWritePermission();
}

function updateSettingsWritePermission() {
  const point = settingsDeviceContext?.points.find((entry) => entry.id === settingsId.value);
  const reading = Boolean(settingsDeviceContext) && (!point?.command || !point.id.startsWith("01/"));
  settingsWritable.disabled = settingsBusy || reading;
  settingsWriteHint.hidden = !settingsDeviceContext;
  settingsWriteHint.textContent = reading
    ? "Ova funkcija služi za očitanje. Dozvola za upis uređuje se na izvornoj naredbenoj funkciji."
    : "Dozvola vrijedi za odabranu naredbu. Stanje Forced i ograničenja kontrolera i dalje se provjeravaju prije upisa.";
}

function openSettingsDialog(id) {
  const widget = configById.get(id);
  if (!widget || !widgetEditingEnabled || settingsBusy || widgetClearBusy) return;
  settingsDeviceContext = null;
  settingsDialog.setAttribute("data-device-settings", "false");
  settingsTitle.textContent = "Uredi widget";
  settingsPointField.hidden = true;
  settingsContext.hidden = true;
  settingsPoint.replaceChildren();
  populateSettingsForm(widget);
  if (!settingsDialog.open) settingsDialog.showModal();
  requestAnimationFrame(() => settingsLabel.focus());
}

function openDeviceSettingsDialog(device) {
  if (!device || !widgetEditingEnabled || settingsBusy || widgetClearBusy) return;
  const candidates = device.primary?.length ? device.primary
    : [...(device.other || []), ...(device.diagnostics || [])];
  const seen = new Set();
  const points = [];
  for (const point of candidates) {
    const id = configById.has(point.sourceId) ? point.sourceId : point.id;
    if (!configById.has(id) || seen.has(id)) continue;
    seen.add(id);
    points.push({ id, label: point.label || configById.get(id).label, command: point.command === true && id.startsWith("01/") });
  }
  points.sort((left, right) => Number(right.command) - Number(left.command));
  if (!points.length) return;
  settingsDeviceContext = { key: device.key, label: device.label, points };
  settingsDialog.setAttribute("data-device-settings", "true");
  settingsTitle.textContent = `Postavke uređaja ${device.label}`;
  settingsPointField.hidden = false;
  settingsContext.hidden = false;
  settingsContext.textContent = `Postavke se odnose na odabranu funkciju uređaja ${device.label}.`;
  settingsPoint.replaceChildren();
  for (const point of points) {
    const option = document.createElement("option");
    option.value = point.id;
    option.textContent = `${point.command ? "Upravljanje" : "Očitanje"} · ${point.label}`;
    settingsPoint.appendChild(option);
  }
  populateSettingsForm(configById.get(points[0].id));
  if (!settingsDialog.open) settingsDialog.showModal();
  requestAnimationFrame(() => settingsPoint.focus());
}

settingsPoint.addEventListener("change", () => {
  if (!settingsDeviceContext || settingsBusy) return;
  const widget = configById.get(settingsPoint.value);
  if (!widget || !settingsDeviceContext.points.some((point) => point.id === widget.id)) {
    showSettingsStatus("Odabrana funkcija više nije dostupna. Ponovno otvori postavke uređaja.", "error");
    return;
  }
  populateSettingsForm(widget);
});

function setSettingsBusy(busy) {
  settingsBusy = busy;
  for (const element of settingsForm.elements) element.disabled = busy;
  settingsClose.disabled = busy;
  settingsDeleteConfirm.disabled = busy;
  settingsDeleteCancel.disabled = busy;
  updateSettingsWritePermission();
}

settingsClose.addEventListener("click", () => { if (!settingsBusy) settingsDialog.close(); });
settingsCancel.addEventListener("click", () => { if (!settingsBusy) settingsDialog.close(); });
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog && !settingsBusy) settingsDialog.close();
});
settingsDialog.addEventListener("cancel", (event) => {
  if (settingsBusy) event.preventDefault();
});

settingsDelete.addEventListener("click", () => {
  if (settingsBusy) return;
  const widget = configById.get(settingsId.value);
  if (!widget) return;
  settingsDeleteMessage.textContent = `Obrisati „${widget.label}” s dashboarda?`;
  settingsDeleteConfirmation.hidden = false;
  settingsDeleteCancel.focus();
});
settingsDeleteCancel.addEventListener("click", () => {
  settingsDeleteConfirmation.hidden = true;
  settingsDelete.focus();
});
settingsDeleteConfirm.addEventListener("click", async () => {
  if (settingsBusy || settingsDeleteConfirmation.hidden) return;
  const id = settingsId.value;
  setSettingsBusy(true);
  showSettingsStatus("Brišem widget…");
  try {
    const response = await fetch("/api/widgets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Brisanje nije uspjelo (${response.status}).`);
    removeConfiguredWidget(id);
    settingsDialog.close();
  } catch (error) {
    showSettingsStatus(error.message || "Brisanje widgeta nije uspjelo.", "error");
  } finally {
    setSettingsBusy(false);
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (settingsBusy) return;
  const rawPrecision = settingsPrecision.value.trim();
  const precision = rawPrecision === "" ? null : Number(rawPrecision);
  const precisionIsValid =
    precision === null ||
    (Number.isInteger(precision) && precision >= 0 && precision <= 6);
  settingsPrecision.setCustomValidity(
    precisionIsValid ? "" : "Broj decimala mora biti cijeli broj od 0 do 6."
  );
  if (!settingsForm.reportValidity() || !precisionIsValid) return;
  const currentWidget = configById.get(settingsId.value);
  if (!currentWidget) return;
  const group = settingsGroup.value.trim();

  const settings = {
    id: settingsId.value,
    label: settingsLabel.value.trim(),
    description: settingsDescription.value.trim(),
    ...(group === widgetGroupName(currentWidget) ? {} : { group }),
    unit: settingsUnit.value.trim(),
    precision,
    writable: settingsWritable.checked,
    visible: settingsVisible.checked,
  };

  setSettingsBusy(true);
  settingsDeleteConfirmation.hidden = true;
  showSettingsStatus("Spremam postavke u widgets.json…");
  try {
    const response = await fetch("/api/widgets/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Spremanje nije uspjelo (${response.status}).`);
    }

    applyConfiguredWidget(payload.widget);
    showSettingsStatus("Postavke widgeta su spremljene.", "success");
  } catch (error) {
    showSettingsStatus(error.message || "Spremanje postavki nije uspjelo.", "error");
  } finally {
    setSettingsBusy(false);
  }
});

writeWidget.addEventListener("change", () => {
  configureWriteValueInput({ clear: true });
  writeStatus.className = "write-status";
  writeStatus.textContent = "";
});

writeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const widget = configById.get(writeWidget.value);
  const parsedValue = parseWriteValue();
  writeValue.setCustomValidity(parsedValue.valid ? "" : parsedValue.message);
  if (!writeForm.reportValidity() || !widget || widget.writable !== true) return;
  const value = parsedValue.value;

  const confirmed = window.confirm(
    `Postaviti "${widget.label}" na ${writeValue.value}${widget.unit ? ` ${widget.unit}` : ""}?`
  );
  if (!confirmed) return;

  writeWidget.disabled = true;
  writeValue.disabled = true;
  writeSubmit.disabled = true;
  writeStatus.className = "write-status";
  writeStatus.textContent = "Šaljem vrijednost kontroleru…";

  try {
    const response = await fetch("/api/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgetId: widget.id, value }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Upis nije uspio (${response.status}).`);
    }
    if (payload.success !== true || payload.id !== widget.id) {
      throw new Error("Dashboard nije primio valjanu potvrdu upisa.");
    }

    writeStatus.className = "write-status is-success";
    writeStatus.textContent = "Kontroler je prihvatio vrijednost. Očitanje će se osvježiti automatski.";
    writeValue.value = "";
  } catch (error) {
    writeStatus.className = "write-status is-error";
    writeStatus.textContent = `${error.message || "Upis nije uspio."} Provjeri trenutačnu vrijednost prije ponovnog pokušaja.`;
  } finally {
    writeWidget.disabled = false;
    writeValue.disabled = false;
    writeSubmit.disabled = false;
  }
});

async function boot() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Konfiguracija nije dostupna.");

    const config = await response.json();
    deviceDemoMode = config.demoMode === true;
    deviceCardView = globalThis.IoTDeviceCards?.create({
      container: document.querySelector("#device-cards-section"),
      onWrite: writeDeviceCommand,
      onSettings: openDeviceCardSettingsDialog,
    });
    demoBadge.hidden = !config.demoMode;
    widgetEditingEnabled = config.widgetEditingEnabled === true;
    deviceSettingsEnabled = config.deviceSettingsEnabled === true;
    applyDeviceSettings(config.deviceSettings || []);
    discoveryOpen.hidden = config.discoveryEnabled !== true;
    visibilityOpen.hidden = !widgetEditingEnabled;
    automaticDiscovery.hidden = !widgetEditingEnabled;
    pollInterval.textContent = `Interval: ${Math.round(config.intervalMs / 1000)} s`;
    config.widgets.forEach(createWidget);
    showAutomaticDiscovery(config.autoDiscovery || { state: "idle" });
    setupWriteControls(config.widgets);
    configureWriteValueInput();
    setupVisibilityControls(config.widgets);
    updateEmptyState();
    void refreshDeviceMetadata();

    const events = new EventSource("/events");
    events.addEventListener("snapshot", (event) => {
      reconcileSnapshot(JSON.parse(event.data));
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
    events.addEventListener("config", (event) => {
      const payload = JSON.parse(event.data);
      applyConfiguredWidgets(payload.widgets || [payload.widget], payload.groupRename);
    });
    events.addEventListener("device-settings", (event) => {
      ++deviceSettingsRequest;
      applyDeviceSettings(JSON.parse(event.data).devices);
    });
    events.addEventListener("device-settings-error", () => {
      deviceSettingsWarning = "Postavke kartica nije moguće spremiti. Provjeri datoteku konfiguracije.";
      refreshDeviceCards();
    });
    events.addEventListener("discovery", (event) => showAutomaticDiscovery(JSON.parse(event.data)));
    events.addEventListener("visibility", (event) => {
      const payload = JSON.parse(event.data);
      setWidgetVisibility(payload.id, payload.visible === true);
    });
    events.addEventListener("removed", (event) => {
      const payload = JSON.parse(event.data);
      removeConfiguredWidgets(Array.isArray(payload.ids) ? payload.ids : [payload.id]);
    });
    events.onopen = () => {
      showStatus({ state: "connecting" });
      void refreshSavedDeviceSettings();
    };
    events.onerror = () => showStatus({
      state: "offline",
      message: "Veza s dashboard servisom je prekinuta. Pokušavam ponovno.",
    });
  } catch (error) {
    showStatus({ state: "offline", message: error.message });
  }
}

boot();
