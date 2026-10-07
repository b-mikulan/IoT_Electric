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
const visibilityItemTemplate = document.querySelector("#visibility-item-template");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsClose = document.querySelector("#settings-close");
const settingsCancel = document.querySelector("#settings-cancel");
const settingsForm = document.querySelector("#settings-form");
const settingsId = document.querySelector("#settings-id");
const settingsLabel = document.querySelector("#settings-label");
const settingsDescription = document.querySelector("#settings-description");
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

const elementsById = new Map();
const configById = new Map();
const visibilityInputsById = new Map();
const latestValuesById = new Map();
let widgetEditingEnabled = false;
let settingsBusy = false;
let lastDiscoveryPayload = null;
let updatingWidgets = false;
let automaticDiscoveryRunning = false;

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

  grid.appendChild(fragment);
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
  emptyState.hidden = [...configById.values()].some(
    (widget) => widget.visible !== false
  );
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

  Object.assign(current, widget);
  const column = elementsById.get(widget.id);
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
  for (const id of [...configById.keys()]) {
    if (!ids.has(id)) removeConfiguredWidget(id);
  }
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

function applyConfiguredWidgets(widgets) {
  updatingWidgets = true;
  try {
    widgets.forEach(applyConfiguredWidget);
  } finally {
    updatingWidgets = false;
    refreshDiscoveryItems();
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
  discoveryAuto.disabled = automaticDiscoveryRunning || !widgetEditingEnabled;
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
  if (automaticDiscoveryRunning) return;
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
  visibilityDialog.showModal();
});

visibilityClose.addEventListener("click", () => visibilityDialog.close());
visibilityDialog.addEventListener("click", (event) => {
  if (event.target === visibilityDialog) visibilityDialog.close();
});

function showSettingsStatus(message, state = "") {
  settingsStatus.className = `discovery-status${state ? ` is-${state}` : ""}`;
  settingsStatus.textContent = message;
}

function openSettingsDialog(id) {
  const widget = configById.get(id);
  if (!widget || !widgetEditingEnabled || settingsBusy) return;

  settingsForm.reset();
  settingsId.value = widget.id;
  settingsLabel.value = widget.label;
  settingsDescription.value = widget.description;
  settingsUnit.value = widget.unit;
  settingsPrecision.value = Number.isInteger(widget.precision)
    ? String(widget.precision)
    : "";
  settingsWritable.checked = widget.writable === true;
  settingsVisible.checked = widget.visible !== false;
  settingsPrecision.setCustomValidity("");
  showSettingsStatus("");
  settingsDeleteConfirmation.hidden = true;
  settingsDialog.showModal();
  requestAnimationFrame(() => settingsLabel.focus());
}

function setSettingsBusy(busy) {
  settingsBusy = busy;
  for (const element of settingsForm.elements) element.disabled = busy;
  settingsClose.disabled = busy;
  settingsDeleteConfirm.disabled = busy;
  settingsDeleteCancel.disabled = busy;
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

  const settings = {
    id: settingsId.value,
    label: settingsLabel.value.trim(),
    description: settingsDescription.value.trim(),
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
    demoBadge.hidden = !config.demoMode;
    widgetEditingEnabled = config.widgetEditingEnabled === true;
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
      applyConfiguredWidgets(payload.widgets || [payload.widget]);
    });
    events.addEventListener("discovery", (event) => showAutomaticDiscovery(JSON.parse(event.data)));
    events.addEventListener("visibility", (event) => {
      const payload = JSON.parse(event.data);
      setWidgetVisibility(payload.id, payload.visible === true);
    });
    events.addEventListener("removed", (event) => {
      removeConfiguredWidget(JSON.parse(event.data).id);
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
