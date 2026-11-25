(function () {
  "use strict";

  const svgPaths = {
    light: ["M9 18h6m-5 3h4", "M8.5 14.5a6 6 0 1 1 7 0c-.9.7-1.5 1.6-1.5 3.5h-4c0-1.9-.6-2.8-1.5-3.5Z"],
    climate: ["M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"],
    blind: ["M4 4h16v16H4zM4 8h16M4 12h16M4 16h16M17 4v13m-1 0h2v3h-2z"],
    sensor: ["M12 13v4m-2 0h4", "M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M11 15a2 2 0 0 1 2 0"],
    zone: ["M3 11 12 3l9 8M5 9v12h14V9M9 21v-7h6v7"],
    generic: ["M5 5h14v14H5zM9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"],
    settings: ["M10 3h4l.5 2.2 1.5.9 2.2-.6 2 3.5-1.7 1.6v1.8l1.7 1.6-2 3.5-2.2-.6-1.5.9-.5 2.2h-4l-.5-2.2-1.5-.9-2.2.6-2-3.5 1.7-1.6v-1.8L3.8 9l2-3.5 2.2.6 1.5-.9L10 3Z", "M15 11.7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
    refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"],
    chevron: ["m9 6 6 6-6 6"],
    power: ["M12 3v8", "M6.3 7.5a8 8 0 1 0 11.4 0"],
    close: ["M6 6l12 12M18 6 6 18"],
    up: ["m6 15 6-6 6 6"],
    down: ["m6 9 6 6 6-6"],
  };
  const roleLabels = {
    brightnessSet: "Zadana svjetlina", brightnessStatus: "Očitana svjetlina",
    positionSet: "Zadani položaj", positionStatus: "Očitani položaj", slatSet: "Zadani kut lamela", slatStatus: "Očitani kut lamela",
    temperature: "Temperatura", humidity: "Vlažnost", co2: "CO₂", setpoint: "Zadana temperatura",
    fanSpeed: "Ventilator", modeSet: "Zadani način rada", modeStatus: "Način rada uređaja", power: "Napajanje",
    illuminance: "Osvijetljenost", occupancy: "Prisutnost",
  };
  const typeLabels = { light: "Svjetlo", lightGroup: "Grupa rasvjete", climate: "Klima", blind: "Roleta", sensor: "Senzor", zone: "Pregled zone", generic: "Uređaj" };
  const formatter = new Intl.NumberFormat("hr-HR", { maximumFractionDigits: 1 });
  const preciseFormatter = new Intl.NumberFormat("hr-HR", { maximumFractionDigits: 3 });
  const CARD_BATCH_SIZE = 24;

  const roomId = room => room?.id || room?.label;
  const roomCaption = room => room ? [room.label, room.floorLabel].filter(Boolean).join(" · ") : "";
  const deviceCount = count => `${count} ${count % 10 === 1 && count % 100 !== 11 ? "uređaj" : "uređaja"}`;

  // Collapsed rooms are a per-browser view preference keyed by the stable room
  // key ("room:<id>" or "unassigned"), never by the editable room name. Storage
  // can be missing or blocked (private mode, file://), so failures fall back
  // to every room being expanded.
  const COLLAPSED_ROOMS_KEY = "iotElectric.dashboard.collapsedRooms";
  function readCollapsedRooms() {
    try {
      const list = JSON.parse(globalThis.localStorage?.getItem(COLLAPSED_ROOMS_KEY) || "[]");
      return new Set(Array.isArray(list) ? list.filter((key) => typeof key === "string" && key) : []);
    } catch { return new Set(); }
  }
  function writeCollapsedRooms(keys) {
    try { globalThis.localStorage?.setItem(COLLAPSED_ROOMS_KEY, JSON.stringify([...keys])); } catch { /* View preference only. */ }
  }

  // Cards or compact tiles, remembered per browser like collapsed rooms.
  // Without a stored choice the full cards are shown.
  const CARD_VIEW_KEY = "iotElectric.dashboard.cardView";
  function readCardView() {
    try { return globalThis.localStorage?.getItem(CARD_VIEW_KEY) === "tiles" ? "tiles" : "cards"; } catch { return "cards"; }
  }
  function writeCardView(view) {
    try { globalThis.localStorage?.setItem(CARD_VIEW_KEY, view); } catch { /* View preference only. */ }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function icon(type) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of svgPaths[type === "lightGroup" ? "light" : type] || svgPaths.generic) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function numeric(value) {
    if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function enumLabel(point, option) {
    const label = String(option.label);
    const key = label.trim().toLowerCase();
    if (point?.role === "power" && /\/OnOffMd$/.test(point.sourceId || point.id || "")) {
      if (String(option.value) === "0") return "Isključeno";
      if (String(option.value) === "1") return "Uključeno";
    }
    if (["modeSet", "modeStatus"].includes(point?.role)) {
      return ({ heat: "Grijanje", cool: "Hlađenje", fan: "Ventilator", dry: "Odvlaživanje", auto: "Automatski" })[key] || label;
    }
    if (point?.role === "fanSpeed") {
      return ({ high: "Visoko", med: "Srednje", medium: "Srednje", low: "Nisko", auto: "Automatski" })[key] || label;
    }
    return label;
  }

  function rawFormat(point) {
    const value = point?.value;
    if (value === undefined || value === null || String(value).trim() === "") return "—";
    const option = (point?.control?.options || point?.metadata?.enumValues || []).find((entry) => String(entry.value) === String(value));
    const rawUnit = point?.metadata?.unit ?? point?.unit;
    return `${String(value)}${option ? ` (${String(option.label)})` : ""}${rawUnit ? ` ${rawUnit}` : ""}`;
  }

  function format(point, value = point?.value) {
    if (value === undefined || value === null || String(value).trim() === "") return "—";
    if (point?.role === "occupancy") {
      const booleanText = String(value).toLowerCase();
      if (booleanText === "0" || booleanText === "false") return "Bez prisutnosti";
      if (booleanText === "1" || booleanText === "true") return "Prisutnost";
    }
    const option = (point?.control?.options || point?.metadata?.enumValues || []).find((entry) => String(entry.value) === String(value));
    if (option) return enumLabel(point, option);
    const number = numeric(value);
    const positionReading = ["positionSet", "positionStatus", "slatSet", "slatStatus"].includes(point?.role);
    const text = number === null ? String(value) : (positionReading ? preciseFormatter : formatter).format(number);
    const unit = displayUnit(point);
    return `${text}${unit ? ` ${unit}` : ""}`;
  }

  function displayUnit(point) {
    let unit = point?.unit || "";
    if (!point?.unitOverridden && point?.role === "humidity" && /^%\s*RH$/i.test(unit)) unit = "%";
    if (!point?.unitOverridden && point?.role === "brightnessSet" && !unit && point?.control?.rangeConfirmed === true && Number(point.control.min) === 0 && Number(point.control.max) === 100) unit = "%";
    return unit;
  }

  // Writes a reading with its unit in a smaller, quieter span; the element's text stays "24,1 °C".
  function renderReading(element, point) {
    const text = point?.error ? "—" : format(point);
    const unit = displayUnit(point);
    const suffix = ` ${unit}`;
    if (!unit || text === "—" || !text.endsWith(suffix)) { element.textContent = text; return; }
    element.textContent = text.slice(0, -suffix.length);
    element.append(el("span", "dc-metric-unit", suffix));
  }

  function statusName(point) {
    if (point?.error) return "Nedostupno";
    return ({ 0: "U redu", 1: "Nesigurno očitanje", 2: "Forsirano", 3: "Izvan mreže", 4: "Greška" })[String(point?.state)] || "Stanje nije poznato";
  }

  // showModeBadge: false when the page header already shows the control mode.
  function create({ container, onWrite, onSettings, onRooms, onMove, onRefresh, readOnly = false, controlDeviceKeys = new Set(), showModeBadge = true }) {
    const canControl = device => !readOnly || controlDeviceKeys.has(device.key);
    if (!container || typeof container.append !== "function") throw new TypeError("Device cards need a DOM container.");
    const cards = new Map();
    const drafts = new Map();
    const commands = new Map();
    const refreshes = new Map();
    let refreshSequence = 0;
    let devices = [];
    let connection = "idle";
    let selectedRoom = "all";
    let selectedFloor = "all";
    let availableRooms = new Map();
    let floors = new Map();
    let floorNames = new Map();
    let roomFloors = new Map();
    let registeredFloors = [];
    let roomDefinitions = [];
    let roomsSignature = "";
    let destroyed = false;
    let demoMode = false;
    let latestReadAt;
    let readClockAvailable = false;
    let settingsEnabled = false;
    let roomEditingEnabled = false;
    let registeredRooms = [];
    let selectionMode = false;
    const selectedKeys = new Set();
    let devicesByKey = new Map();
    let filteredDevices = [];
    let searchIndex = new Map();
    let displayLimit = CARD_BATCH_SIZE;
    let filterSignature = "";
    let deviceIndex = null;
    let devicePositions = new Map();
    // Device keys in display order: floor, room, then kind of device.
    let displayOrder = [];
    const headings = new Map();
    const collapsedRooms = readCollapsedRooms();
    // Cards that fit the filters but are not mounted because their room is collapsed.
    let foldedTotal = 0;
    let visibleTotal = 0;
    let pageEntryCount = 0;
    let shownCardCount = 0;
    let savedSettings = [];
    let memberParents = new Map();
    // A light listed by several shown groups: its own card sits in the first
    // of them and every other one holds a mirror card (device key -> parent key -> card).
    const mirrors = new Map();
    let pageDevices = [];
    // Tile view: each top-level card shows a compact tile, and one card at a
    // time opens as a sheet with its full controls. Both are the same card, so
    // commands, permissions and readback are shared.
    let tileView = readCardView() === "tiles";
    let openCard = null;
    let sheetReturnFocus = null;

    container.classList.add("device-cards-section");
    container.classList.toggle("dc-view-tiles", tileView);
    const headerActions = el("div", "dc-header-actions");
    const simulationBadge = el("span", "chip dc-simulation-badge", "Simulacija upravljanja");
    const reset = el("button", "dc-reset", "Vrati simulaciju");
    reset.type = "button";
    reset.hidden = true;
    reset.addEventListener("click", () => {
      drafts.clear();
      for (const card of allCards()) card.update(card.device);
      reset.hidden = true;
      announce.textContent = "Simulacija je vraćena na trenutačna očitanja.";
    });
    simulationBadge.hidden = !showModeBadge;
    const viewSwitch = el("div", "dc-view-switch");
    viewSwitch.setAttribute("role", "group");
    viewSwitch.setAttribute("aria-label", "Prikaz uređaja");
    const viewButtons = [["cards", "Kartice"], ["tiles", "Pločice"]].map(([view, label]) => {
      const button = el("button", "dc-view-option", label);
      button.type = "button";
      button.dataset.view = view;
      button.addEventListener("click", () => setView(view));
      viewSwitch.append(button);
      return button;
    });
    headerActions.append(viewSwitch, simulationBadge, reset);
    const searchTools = el("div", "dc-search-tools");
    const searchField = el("fieldset", "form-field dc-search-field");
    const search = el("input", "dc-search");
    search.type = "search";
    search.id = "device-search";
    search.value = "";
    search.placeholder = "Naziv, prostorija ili putanja";
    search.setAttribute("aria-label", "Pretraži uređaje");
    search.addEventListener("input", applyFilter);
    const searchLabel = el("label", "", "Pretraži uređaje");
    searchLabel.setAttribute("for", search.id);
    searchField.append(el("legend", "", "Pretraži uređaje"), search, searchLabel);
    const typeField = el("fieldset", "form-field dc-type-field");
    const typeFilter = el("select", "browser-default dc-type-filter");
    typeFilter.id = "device-type-filter";
    typeFilter.setAttribute("aria-label", "Vrsta uređaja");
    for (const [value, label] of [["all", "Sve vrste"], ...Object.entries(typeLabels)]) {
      const option = el("option", "", label);
      option.value = value;
      typeFilter.append(option);
    }
    typeFilter.value = "all";
    typeFilter.addEventListener("change", applyFilter);
    const typeLabel = el("label", "", "Vrsta uređaja");
    typeLabel.setAttribute("for", typeFilter.id);
    typeField.append(el("legend", "", "Vrsta uređaja"), typeFilter, typeLabel);
    searchTools.append(searchField, typeField, headerActions);
    const management = el("div", "dc-management");
    const manageRooms = el("button", "btn-small outlined dc-manage-rooms", "Prostorije");
    manageRooms.type = "button";
    manageRooms.addEventListener("click", () => { if (roomEditingEnabled && typeof onRooms === "function") onRooms(); });
    const selectDevices = el("button", "btn-small outlined dc-select-devices", "Odaberi uređaje");
    selectDevices.type = "button";
    selectDevices.addEventListener("click", () => {
      if (!roomEditingEnabled) return;
      selectionMode = !selectionMode;
      if (!selectionMode) selectedKeys.clear();
      managementStatus.hidden = true;
      applyFilter();
    });
    management.append(manageRooms, selectDevices);
    const selectionActions = el("div", "dc-selection-actions");
    const selectionCount = el("span", "dc-selection-count");
    const selectShown = el("button", "btn-small outlined dc-select-shown", "Odaberi sve rezultate");
    const clearSelected = el("button", "btn-small outlined dc-clear-selection", "Poništi odabir");
    const moveSelected = el("button", "btn-small filled dc-move-selection", "Premjesti u prostoriju");
    for (const button of [selectShown, clearSelected, moveSelected]) button.type = "button";
    selectShown.addEventListener("click", () => {
      if (!selectionMode || !roomEditingEnabled) return;
      // Selection covers the complete filter result, including cards that
      // have not been mounted by progressive scrolling yet.
      for (const device of filteredDevices) selectedKeys.add(device.key);
      applyFilter();
    });
    clearSelected.addEventListener("click", () => { selectedKeys.clear(); applyFilter(); });
    moveSelected.addEventListener("click", () => {
      if (roomEditingEnabled && selectedKeys.size && typeof onMove === "function") onMove([...selectedKeys].map((key) => devicesByKey.get(key)).filter(Boolean));
    });
    selectionActions.append(selectionCount, selectShown, clearSelected, moveSelected);
    const managementStatus = el("p", "dc-management-status");
    managementStatus.setAttribute("role", "status");
    managementStatus.hidden = true;
    const floorFilters = el("div", "dc-floor-filters");
    floorFilters.setAttribute("role", "group");
    floorFilters.setAttribute("aria-label", "Prikaz uređaja po katu");
    const roomListLabel = el("p", "dc-room-list-label");
    const floorHint = el("p", "dc-floor-hint");
    const filters = el("div", "dc-room-filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Prikaz uređaja po prostoriji");
    const roomPanel = el("details", "collapsible app-disclosure dc-room-panel");
    const roomSummary = el("summary", "collapsible-header", "Kat i prostorija: svi uređaji");
    const roomPanelBody = el("div", "collapsible-body");
    roomPanelBody.append(floorFilters, roomListLabel, filters, floorHint);
    roomPanel.append(roomSummary, roomPanelBody);
    const scopeActions = el("div", "dc-scope-actions");
    const refreshFloor = el("button", "btn-small outlined dc-refresh-floor");
    const refreshRoom = el("button", "btn-small outlined dc-refresh-room");
    const floorRefreshLabel = el("span");
    const roomRefreshLabel = el("span");
    refreshFloor.type = refreshRoom.type = "button";
    refreshFloor.append(icon("refresh"), floorRefreshLabel);
    refreshRoom.append(icon("refresh"), roomRefreshLabel);
    refreshFloor.title = "Osvježi sve uređaje na odabranom katu, bez obzira na pretragu i vrstu uređaja.";
    refreshRoom.title = "Osvježi sve uređaje u odabranoj prostoriji, bez obzira na pretragu i vrstu uređaja.";
    const floorTarget = () => ({ scope: "floor", id: selectedFloor === "unknown" ? null : selectedFloor });
    const roomTarget = () => ({ scope: "room", id: selectedRoom === "unassigned" ? null : selectedRoom.slice(5) });
    refreshFloor.addEventListener("click", () => { if (!refreshFloor.hidden) void startRefresh(floorTarget(), floorLabel(selectedFloor)); });
    refreshRoom.addEventListener("click", () => { if (!refreshRoom.hidden) void startRefresh(roomTarget(), selectedRoom === "unassigned" ? "Bez prostorije" : availableRooms.get(selectedRoom)); });
    scopeActions.append(refreshFloor, refreshRoom);
    const scopeStatus = el("p", "dc-refresh-status dc-scope-status");
    scopeStatus.setAttribute("role", "status");
    scopeStatus.setAttribute("aria-live", "polite");
    scopeStatus.hidden = true;
    const summary = el("p", "dc-summary");
    const readWarning = el("p", "dc-read-warning");
    readWarning.setAttribute("role", "status");
    readWarning.hidden = true;
    const grid = el("div", "dc-grid");
    const loadMore = el("div", "dc-load-more");
    const loadCount = el("p", "dc-load-count");
    const loadButton = el("button", "btn outlined dc-load-button", "Prikaži još uređaja");
    loadButton.type = "button";
    loadButton.addEventListener("click", showMore);
    loadMore.append(loadCount, loadButton);
    const empty = el("div", "dc-empty");
    const emptyTitle = el("h3", "", "Kartice čekaju vrijednosti");
    const emptyDescription = el("p", "", "Dodaj vrijednosti uređaja u postojeći prikaz. Njihove prepoznate funkcije pojavit će se zajedno ovdje.");
    empty.append(icon("generic"), emptyTitle, emptyDescription);
    const sheetBackdrop = el("div", "dc-sheet-backdrop");
    sheetBackdrop.hidden = true;
    sheetBackdrop.addEventListener("click", () => closeSheet());
    const announce = el("div", "dc-sr-only");
    announce.setAttribute("role", "status");
    announce.setAttribute("aria-live", "polite");
    container.replaceChildren(searchTools, management, selectionActions, managementStatus, roomPanel, scopeActions, scopeStatus, summary, readWarning, grid, loadMore, empty, sheetBackdrop, announce);
    container.addEventListener("keydown", (event) => { if (event.key === "Escape" && openCard) { event.preventDefault?.(); closeSheet(); } });
    syncViewSwitch();
    const scrollObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loadMore.hidden) showMore();
    }, { rootMargin: "0px 0px 500px 0px" }) : null;
    scrollObserver?.observe(loadMore);

    function syncViewSwitch() {
      for (const button of viewButtons) button.setAttribute("aria-pressed", String(button.dataset.view === (tileView ? "tiles" : "cards")));
    }

    function setView(view) {
      const next = view === "tiles";
      if (destroyed || next === tileView) return;
      closeSheet();
      tileView = next;
      writeCardView(tileView ? "tiles" : "cards");
      container.classList.toggle("dc-view-tiles", tileView);
      syncViewSwitch();
    }

    function openSheet(card, returnFocus) {
      if (destroyed || !tileView || card.node.hidden) return;
      if (openCard && openCard !== card) closeSheet();
      openCard = card;
      sheetReturnFocus = returnFocus || null;
      card.node.classList.toggle("dc-sheet-open", true);
      card.node.setAttribute("role", "dialog");
      card.node.setAttribute("aria-modal", "true");
      card.node.setAttribute("aria-label", card.device.label);
      sheetBackdrop.hidden = false;
      if (typeof card.sheetClose?.focus === "function") card.sheetClose.focus();
    }

    function closeSheet() {
      if (!openCard) return;
      const card = openCard;
      openCard = null;
      card.node.classList.toggle("dc-sheet-open", false);
      for (const name of ["role", "aria-modal", "aria-label"]) card.node.removeAttribute?.(name);
      sheetBackdrop.hidden = true;
      const target = sheetReturnFocus;
      sheetReturnFocus = null;
      if (target?.isConnected !== false && typeof target?.focus === "function") target.focus();
    }

    function roomKey(device) {
      return roomId(device.room) ? `room:${roomId(device.room)}` : "unassigned";
    }

    function floorLabel(key) { return floorNames.get(key) || "Kat nije određen"; }

    const refreshKey = target => JSON.stringify([target.scope, target.id]);
    function paintRefresh(button, target, status) {
      const state = refreshes.get(refreshKey(target));
      button.disabled = state?.pending === true;
      button.setAttribute("aria-busy", String(state?.pending === true));
      button.classList.toggle("dc-refresh-busy", state?.pending === true);
      if (status) {
        status.hidden = !state;
        status.textContent = state?.message || "";
        status.classList.toggle("dc-refresh-error", state?.error === true);
      }
    }
    function renderScopeActions() {
      const enabled = typeof onRefresh === "function";
      refreshFloor.hidden = !enabled || selectedFloor === "all";
      refreshRoom.hidden = !enabled || selectedRoom === "all";
      scopeActions.hidden = refreshFloor.hidden && refreshRoom.hidden;
      floorRefreshLabel.textContent = "Osvježi kat";
      roomRefreshLabel.textContent = "Osvježi prostoriju";
      refreshFloor.setAttribute("aria-label", `Osvježi kat: ${floorLabel(selectedFloor)}`);
      refreshRoom.setAttribute("aria-label", `Osvježi prostoriju: ${availableRooms.get(selectedRoom) || "Bez prostorije"}`);
      paintRefresh(refreshFloor, floorTarget());
      paintRefresh(refreshRoom, roomTarget());
      const state = [!refreshRoom.hidden && refreshes.get(refreshKey(roomTarget())),
        !refreshFloor.hidden && refreshes.get(refreshKey(floorTarget()))].filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
      scopeStatus.hidden = !state;
      scopeStatus.textContent = state?.message || "";
      scopeStatus.classList.toggle("dc-refresh-error", state?.error === true);
    }
    async function startRefresh(target, label, button, status) {
      if (destroyed || typeof onRefresh !== "function" || refreshes.get(refreshKey(target))?.pending) return;
      const state = { pending: true, message: `${label}: čekam očitanja…`, error: false, sequence: ++refreshSequence };
      refreshes.set(refreshKey(target), state);
      const paint = () => { if (!destroyed) { if (button) paintRefresh(button, target, status); renderScopeActions(); } };
      paint();
      try {
        const result = await onRefresh(target);
        state.message = `${label}: osvježeno ${new Date(result.readAt).toLocaleTimeString("hr-HR")} · ${result.pointCount} pointova${result.errorCount ? ` · ${result.errorCount} bez očitanja` : ""}.`;
        state.error = result.errorCount > 0;
      } catch (error) {
        state.message = `${label}: osvježavanje nije uspjelo. ${error.message || error}`;
        state.error = true;
      } finally { state.pending = false; paint(); }
    }

    function searchText(value) {
      return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("hr");
    }

    function updateSummary() {
      const count = filteredDevices.length;
      const shown = shownCardCount;
      summary.textContent = devices.length ? `${count === devices.length ? count : `${count} od ${devices.length}`} kartica uređaja${shown < visibleTotal ? ` · prikazano ${shown}` : ""}${foldedTotal ? ` · ${foldedTotal} u sklopljenim prostorijama` : ""}${connection !== "connected" ? " · Očitanja se trenutačno ne osvježavaju" : ""}` : "";
    }

    // Lights inside their groups and sensors inside their zone: member key ->
    // parent keys. Saved settings, not device objects, carry membership, so
    // live value updates never move a light out of its group.
    function groupMembership() {
      return globalThis.IoTDeviceModel?.deviceMembership?.(devices, savedSettings) || new Map();
    }

    // Every card of one device: its own card first, then its mirrors.
    function instancesOf(key) {
      return [cards.get(key), ...(mirrors.get(key)?.values() || [])].filter(Boolean);
    }

    function allCards() {
      return [...cards.values(), ...[...mirrors.values()].flatMap((byParent) => [...byParent.values()])];
    }

    function reconcileCommand(device) {
      const command = commands.get(device.key);
      if (command?.status !== "accepted") return false;
      const point = device.roles?.[command.role];
      const fresh = point?.readAt && point.readAt !== command.acceptedPointReadAt
        || (command.usesReadClock
          ? latestReadAt !== undefined && latestReadAt !== null && latestReadAt !== command.acceptedReadAt
          : point?.updatedAt && point.updatedAt !== command.previousUpdatedAt);
      if (!fresh || !point || point.error || Number(point.state) !== 0) return false;
      if (String(point.value) !== String(command.value) && !(numeric(point.value) !== null && numeric(point.value) === numeric(command.value))) return false;
      command.status = "readback";
      drafts.delete(`${device.key}\u0000${command.role}`);
      return true;
    }

    function updateCard(device) {
      const instances = instancesOf(device.key);
      if (!instances.length) return false;
      for (const [role, previousPoint] of Object.entries(instances[0].device.roles || {})) {
        const nextPoint = device.roles?.[role];
        if (!nextPoint?.control || (previousPoint.sourceId || previousPoint.id) !== (nextPoint.sourceId || nextPoint.id)) {
          drafts.delete(`${device.key}\u0000${role}`);
          if (commands.get(device.key)?.role === role) commands.delete(device.key);
        }
      }
      let updated = false;
      for (const card of instances) {
        if (card.node.hidden) { card.device = device; card.needsRefresh = true; continue; }
        card.update(device);
        updated = true;
      }
      return updated;
    }

    function showMore() {
      if (destroyed || displayLimit >= pageEntryCount) return;
      displayLimit += CARD_BATCH_SIZE;
      applyFilter();
    }

    // Recomputed on a full update or when a label, type or room changes, so
    // live readings never move a card.
    function computeDisplayOrder() {
      const sort = globalThis.IoTDeviceModel?.sortDevicesForDisplay;
      displayOrder = (typeof sort === "function" ? sort(devices, registeredFloors) : devices).map((device) => device.key);
    }

    // A heading opens each floor and room in the shown slice, but only when
    // the whole result spans more than one of them; a room continued after
    // "Prikaži još uređaja" keeps its single heading. When floors are headed,
    // devices without a room sit under their own floor-level "Bez prostorije"
    // heading, matching the filter bar where it stands beside the floors.
    function headingFloorKey(device) { return device.room?.label ? device.room.floorId || "unknown" : null; }

    function heading(key, className, text) {
      let node = headings.get(key);
      if (!node) { node = el("h3", `dc-grid-heading ${className}`); headings.set(key, node); }
      if (node.textContent !== text) node.textContent = text;
      return node;
    }

    function headingLayout(page) {
      const showFloors = new Set(page.map(headingFloorKey).filter(Boolean)).size > 1;
      const showRooms = new Set(page.map(roomKey)).size > 1;
      // Only a device under a room heading can be collapsed, so a hidden card
      // always has a visible toggle that brings it back.
      return { showFloors, showRooms, roomHeaded: (device) => showRooms && !(showFloors && !headingFloorKey(device)) };
    }

    // A room heading is a disclosure button. Its count is shown only while the
    // room is collapsed, since the cards themselves show it otherwise.
    function roomHeading(key, text, { folded, count, collapsible }) {
      let node = headings.get(key);
      if (!node) {
        node = el("h3", "dc-grid-heading dc-grid-heading-room");
        const toggle = el("button", "dc-room-toggle");
        toggle.type = "button";
        const name = el("span", "dc-room-toggle-name");
        const total = el("span", "dc-room-toggle-count");
        toggle.append(icon("chevron"), name, total);
        toggle.addEventListener("click", () => {
          if (toggle.disabled) return;
          if (collapsedRooms.has(key)) collapsedRooms.delete(key); else collapsedRooms.add(key);
          writeCollapsedRooms(collapsedRooms);
          applyFilter();
          // Re-inserting nearby cards must not drop keyboard focus.
          if (typeof toggle.focus === "function" && document.activeElement !== toggle && toggle.isConnected !== false) toggle.focus();
        });
        node.append(toggle);
        node.roomToggle = { toggle, name, total };
        headings.set(key, node);
      }
      const { toggle, name, total } = node.roomToggle;
      if (name.textContent !== text) name.textContent = text;
      const totalText = folded ? deviceCount(count) : "";
      if (total.textContent !== totalText) total.textContent = totalText;
      toggle.disabled = !collapsible;
      toggle.setAttribute("aria-expanded", String(!folded));
      toggle.setAttribute("aria-label", `${text} · ${deviceCount(count)}`);
      toggle.title = !collapsible ? "Sklapanje prostorija ne vrijedi dok su pretraga ili vrsta uređaja aktivne."
        : folded ? "Prikaži uređaje u prostoriji" : "Sakrij uređaje u prostoriji";
      node.classList.toggle("dc-room-collapsed", folded);
      return node;
    }

    // entries: devices in page order, where a collapsed room contributes only
    // its first device, as a marker for its heading.
    function withHeadings(entries, layout, { folded, roomCounts, collapsible }) {
      const { showFloors, showRooms } = layout;
      const nodes = [];
      let lastFloor, lastRoom;
      for (const device of entries) {
        const floorKey = headingFloorKey(device);
        const key = roomKey(device);
        if (showFloors && !floorKey) {
          if (lastFloor !== "unassigned") nodes.push(heading("floor:unassigned", "dc-grid-heading-floor", "Bez prostorije"));
          lastFloor = "unassigned";
        } else {
          if (showFloors && floorKey !== lastFloor) nodes.push(heading(`floor:${floorKey}`, "dc-grid-heading-floor", floorLabel(floorKey)));
          lastFloor = floorKey;
          if (showRooms && key !== lastRoom) nodes.push(roomHeading(key, device.room?.label || "Bez prostorije", { folded: folded(device), count: roomCounts.get(key) || 0, collapsible }));
        }
        lastRoom = key;
        if (!folded(device)) nodes.push(cards.get(device.key).node);
      }
      const used = new Set(nodes);
      for (const node of headings.values()) if (!used.has(node)) node.remove();
      return nodes;
    }

    function applyFilter() {
      const query = searchText(search.value.trim());
      const signature = JSON.stringify([query, selectedFloor, selectedRoom, typeFilter.value]);
      if (signature !== filterSignature) { filterSignature = signature; displayLimit = CARD_BATCH_SIZE; }
      filteredDevices = displayOrder.map((key) => devicesByKey.get(key)).filter((device) => device && (selectedRoom === "all" || roomKey(device) === selectedRoom)
        && (selectedFloor === "all" || device.room && (device.room.floorId || "unknown") === selectedFloor)
        && (typeFilter.value === "all" || device.type === typeFilter.value) && searchIndex.get(device.key)?.includes(query));
      const count = filteredDevices.length;
      // A text search lists matching lights on their own, captioned with their
      // groups. Otherwise a shown group holds all of its accessible lights,
      // and only lights whose groups are all filtered out stay on the main list.
      const nested = query === "";
      // filteredDevices follows displayOrder, so its index orders a light's parents.
      const filteredIndex = new Map(filteredDevices.map((device, index) => [device.key, index]));
      const filteredParents = (key) => (memberParents.get(key) || []).filter((parent) => filteredIndex.has(parent))
        .sort((a, b) => filteredIndex.get(a) - filteredIndex.get(b));
      pageDevices = nested ? filteredDevices.filter((device) => !filteredParents(device.key).length) : filteredDevices;
      // Collapsing is ignored while a search or type filter is active, so a
      // match inside a collapsed room is never hidden. The saved state is kept.
      const collapsible = query === "" && typeFilter.value === "all";
      const layout = headingLayout(pageDevices);
      const roomCounts = new Map();
      // Counts include lights and sensors nested in group or zone cards, like the room registry.
      for (const device of filteredDevices) roomCounts.set(roomKey(device), (roomCounts.get(roomKey(device)) || 0) + 1);
      const folded = (device) => collapsible && layout.roomHeaded(device) && collapsedRooms.has(roomKey(device));
      // A collapsed room keeps one marker entry for its heading, so its cards
      // never use up the progressive display limit.
      const entries = [];
      const markedRooms = new Set();
      let foldedCards = 0;
      for (const device of pageDevices) {
        if (!folded(device)) { entries.push(device); continue; }
        foldedCards++;
        if (!markedRooms.has(roomKey(device))) { markedRooms.add(roomKey(device)); entries.push(device); }
      }
      foldedTotal = [...markedRooms].reduce((total, key) => total + (roomCounts.get(key) || 0), 0);
      pageEntryCount = entries.length;
      visibleTotal = pageDevices.length - foldedCards;
      const shownEntries = entries.slice(0, displayLimit);
      const shownDevices = shownEntries.filter((device) => !folded(device));
      shownCardCount = shownDevices.length;
      const members = new Map();
      if (nested) for (const device of devices) {
        for (const parent of memberParents.get(device.key) || []) members.set(parent, [...(members.get(parent) || []), device]);
      }
      const cardFor = (device) => {
        if (!cards.has(device.key)) cards.set(device.key, makeCard(device));
        return cards.get(device.key);
      };
      // A light's own card goes to its first filtered parent; the others get its mirrors.
      const shownKeys = new Set();
      const rows = new Map();
      const usedMirrors = new Set();
      for (const device of shownDevices) {
        cardFor(device);
        shownKeys.add(device.key);
        rows.set(device.key, (members.get(device.key) || []).map((member) => {
          if (filteredParents(member.key)[0] === device.key) { shownKeys.add(member.key); return cardFor(member); }
          if (!mirrors.has(member.key)) mirrors.set(member.key, new Map());
          const byParent = mirrors.get(member.key);
          if (!byParent.has(device.key)) byParent.set(device.key, makeCard(member));
          usedMirrors.add(byParent.get(device.key));
          return byParent.get(device.key);
        }));
      }
      const topLevel = new Set(shownDevices.map((device) => device.key));
      for (const card of allCards()) {
        const device = card.device;
        const mirror = cards.get(device.key) !== card;
        const shown = mirror ? usedMirrors.has(card) : shownKeys.has(device.key);
        if (shown && card.needsRefresh) { card.update(device); card.needsRefresh = false; }
        card.node.hidden = !shown;
        if (!shown) card.node.remove();
        card.selection.hidden = !selectionMode;
        card.checkbox.checked = selectedKeys.has(device.key);
        card.node.classList.toggle("dc-card-selected", selectedKeys.has(device.key));
        // A top-level card has no filtered parent (or search is on), so it names all of them.
        const parents = !mirror && topLevel.has(device.key) ? memberParents.get(device.key) || [] : [];
        card.setGroupNote(parents.map((parent) => devicesByKey.get(parent)).filter(Boolean));
      }
      // Moving existing nodes preserves focused controls and their drafts.
      // Only the requested slice, with its headings, belongs to the live grid.
      const nodes = withHeadings(shownEntries, layout, { folded, roomCounts, collapsible });
      for (let index = 0; index < nodes.length; index++) {
        if (grid.children[index] !== nodes[index]) grid.insertBefore(nodes[index], grid.children[index] || null);
      }
      for (const device of shownDevices) cards.get(device.key).setMembers(rows.get(device.key).map((row) => row.node));
      // The sheet belongs to a shown top-level card; filters, collapsed rooms
      // and removed devices close it.
      if (openCard && (openCard.node.hidden || !topLevel.has(openCard.device.key) || cards.get(openCard.device.key) !== openCard)) closeSheet();
      loadMore.hidden = shownEntries.length >= entries.length;
      loadCount.textContent = `Prikazano ${shownDevices.length} od ${visibleTotal} uređaja`;
      loadButton.disabled = loadMore.hidden;
      selectShown.title = `Odaberi sve uređaje koji odgovaraju filtrima (${count}), uključujući one niže na popisu.`;
      selectShown.textContent = `Odaberi sve rezultate (${count})`;
      for (const button of filters.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.room === selectedRoom));
      }
      for (const button of floorFilters.querySelectorAll("button")) {
        const pressed = button.dataset.floor ? button.dataset.floor === selectedFloor
          : selectedFloor === "all" && button.dataset.room === selectedRoom;
        button.setAttribute("aria-pressed", String(pressed));
      }
      roomSummary.textContent = selectedRoom === "unassigned" ? "Kat i prostorija: bez prostorije"
        : selectedRoom !== "all" ? `Prostorije: ${availableRooms.get(selectedRoom)}${selectedFloor !== "all" ? ` · ${floorLabel(selectedFloor)}` : ""}`
          : selectedFloor === "all" ? "Kat i prostorija: svi uređaji"
            : `Kat i prostorija: ${floorLabel(selectedFloor)} · sve prostorije`;
      updateSummary();
      emptyTitle.textContent = devices.length ? "Nema pronađenih uređaja" : "Kartice čekaju vrijednosti";
      emptyDescription.textContent = devices.length ? "Promijeni pretragu, vrstu uređaja, kat ili prostoriju." : "Dodaj vrijednosti uređaja u postojeći prikaz. Njihove prepoznate funkcije pojavit će se zajedno ovdje.";
      empty.hidden = count !== 0;
      grid.hidden = count === 0;
      roomPanel.hidden = devices.length === 0;
      management.hidden = !roomEditingEnabled;
      manageRooms.hidden = !roomEditingEnabled || typeof onRooms !== "function";
      selectDevices.hidden = !roomEditingEnabled || typeof onMove !== "function";
      selectDevices.textContent = selectionMode ? "Gotovo" : "Odaberi uređaje";
      selectDevices.setAttribute("aria-pressed", String(selectionMode));
      selectionActions.hidden = !selectionMode || !roomEditingEnabled;
      selectionCount.textContent = `Odabrano: ${selectedKeys.size}`;
      clearSelected.disabled = selectedKeys.size === 0;
      moveSelected.disabled = selectedKeys.size === 0;
      selectShown.disabled = count === 0;
      renderScopeActions();
    }

    function renderRoomFilters() {
      filters.replaceChildren();
      const choosingFloor = selectedFloor === "all";
      filters.hidden = choosingFloor;
      roomListLabel.hidden = choosingFloor;
      roomListLabel.textContent = choosingFloor ? "" : `Prostorije · ${floorLabel(selectedFloor)}`;
      floorHint.hidden = !choosingFloor || selectedRoom === "unassigned" || !floors.size;
      floorHint.textContent = "Odaberi kat za prikaz njegovih prostorija.";
      if (choosingFloor) return;
      const available = [["all", "Sve prostorije"], ...[...availableRooms].filter(([key]) => roomFloors.get(key) === selectedFloor)];
      for (const [key, label] of available) {
        const button = el("button", "btn-small outlined dc-room-filter", label);
        button.type = "button";
        button.dataset.room = key;
        if (key !== "all") button.title = label;
        button.addEventListener("click", () => { selectedRoom = key; applyFilter(); });
        filters.append(button);
      }
    }

    function updateFilters() {
      const available = new Map();
      const definitions = new Map(roomDefinitions.map(room => [room.id, room]));
      const nextRoomFloors = new Map();
      for (const room of registeredRooms) if (typeof room === "string" && room) {
        const detail = definitions.get(room);
        available.set(`room:${room}`, detail?.name || room);
        nextRoomFloors.set(`room:${room}`, detail?.floorId || "unknown");
      }
      for (const room of roomDefinitions) {
        available.set(`room:${room.id}`, room.name);
        nextRoomFloors.set(`room:${room.id}`, room.floorId || "unknown");
      }
      for (const device of devices) if (device.room?.label) {
        available.set(roomKey(device), device.room.label);
        nextRoomFloors.set(roomKey(device), device.room.floorId || "unknown");
      }
      const ordered = [...available].sort((a, b) => a[1].localeCompare(b[1], "hr", { numeric: true }));
      const hasUnassigned = devices.some(device => !device.room?.label);
      const signature = JSON.stringify([ordered, [...nextRoomFloors], registeredFloors, hasUnassigned]);
      if (signature === roomsSignature) return;
      roomsSignature = signature;
      availableRooms = new Map(ordered);
      roomFloors = nextRoomFloors;
      floorNames = new Map(registeredFloors.map(floor => [floor.id, floor.name]));
      floors = new Map(registeredFloors.map(floor => [floor.id, 0]));
      for (const [id] of ordered) {
        const key = roomFloors.get(id);
        floors.set(key, (floors.get(key) || 0) + 1);
      }
      if (selectedFloor !== "all" && !floors.has(selectedFloor)) { selectedFloor = "all"; selectedRoom = "all"; }
      if (selectedRoom !== "all" && !(selectedRoom === "unassigned" ? hasUnassigned : availableRooms.has(selectedRoom))) selectedRoom = "all";
      floorFilters.replaceChildren();
      for (const [key, label] of [["all", "Svi uređaji"], ...(hasUnassigned ? [["unassigned", "Bez prostorije"]] : [])]) {
        const button = el("button", "btn-small outlined dc-room-filter", label);
        button.type = "button";
        button.dataset.room = key;
        button.addEventListener("click", () => { selectedFloor = "all"; selectedRoom = key; renderRoomFilters(); applyFilter(); });
        floorFilters.append(button);
      }
      const orderedFloors = [...floors].filter(([key]) => key !== "unknown").concat(floors.has("unknown") ? [["unknown", floors.get("unknown")]] : []);
      for (const [key, count] of orderedFloors) {
        const button = el("button", "btn-small outlined dc-floor-filter");
        button.type = "button";
        button.dataset.floor = key;
        button.setAttribute("aria-label", `${floorLabel(key)} · ${count} prostorija`);
        button.append(el("span", "dc-floor-name", floorLabel(key)), el("span", "dc-floor-count", count));
        button.addEventListener("click", () => { selectedFloor = key; selectedRoom = "all"; renderRoomFilters(); applyFilter(); });
        floorFilters.append(button);
      }
      renderRoomFilters();
    }

    function makeCard(initial) {
      const node = el("article", `card-panel dc-card dc-type-${initial.type}`);
      node.dataset.deviceKey = initial.key;
      const card = { node, device: initial, bindings: [], signature: "" };
      const selectionLabel = el("label", "dc-card-selection");
      const checkbox = el("input", "dc-device-checkbox browser-default");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => {
        if (!selectionMode || !roomEditingEnabled) return;
        if (checkbox.checked) selectedKeys.add(card.device.key); else selectedKeys.delete(card.device.key);
        applyFilter();
      });
      selectionLabel.append(checkbox, el("span", "", "Odaberi uređaj"));
      card.selection = selectionLabel;
      card.checkbox = checkbox;
      const top = el("div", "dc-card-top");
      const deviceIcon = el("span", "dc-device-icon");
      deviceIcon.append(icon(initial.type));
      const identity = el("div", "dc-identity");
      const title = el("h3", "dc-card-title", initial.label);
      const room = el("p", "dc-room");
      const groupNote = el("p", "dc-group-note");
      groupNote.hidden = true;
      identity.append(title, room, groupNote);
      card.setGroupNote = (parents) => {
        groupNote.hidden = parents.length === 0;
        const text = parents.length > 1 ? `U grupama: ${parents.map((parent) => parent.label).join(", ")}`
          : parents.length ? `${parents[0].type === "zone" ? "U zoni" : "U grupi"}: ${parents[0].label}` : "";
        if (groupNote.textContent !== text) groupNote.textContent = text;
      };
      const settings = el("button", "dc-settings-button");
      settings.type = "button";
      settings.hidden = true;
      settings.setAttribute("aria-haspopup", "dialog");
      settings.append(icon("settings"));
      settings.addEventListener("click", () => {
        if (!destroyed && settingsEnabled && typeof onSettings === "function") onSettings(card.device);
      });
      const refresh = el("button", "dc-refresh-button dc-refresh-device");
      refresh.type = "button";
      refresh.hidden = typeof onRefresh !== "function";
      refresh.append(icon("refresh"));
      const refreshStatus = el("p", "dc-refresh-status");
      refreshStatus.setAttribute("role", "status");
      refreshStatus.setAttribute("aria-live", "polite");
      refreshStatus.hidden = true;
      refresh.addEventListener("click", () => void startRefresh({ scope: "device", id: card.device.key }, card.device.label, refresh, refreshStatus));
      const cardActions = el("div", "dc-card-actions");
      cardActions.append(refresh, settings);
      const type = el("span", "dc-type-label", typeLabels[initial.type] || "Uređaj");
      // Shown only while the card is a row inside a light group, where it
      // opens the room, refresh, settings and details (see deviceCards.css).
      let memberOpen = false;
      const expand = el("button", "dc-member-expand");
      expand.type = "button";
      expand.append(icon("chevron"));
      const syncMemberOpen = () => {
        node.classList.toggle("dc-member-open", memberOpen);
        expand.setAttribute("aria-expanded", String(memberOpen));
      };
      expand.addEventListener("click", () => { memberOpen = !memberOpen; syncMemberOpen(); });
      const sheetClose = el("button", "dc-sheet-close");
      sheetClose.type = "button";
      sheetClose.append(icon("close"));
      sheetClose.addEventListener("click", () => closeSheet());
      card.sheetClose = sheetClose;
      const sheetChip = el("span", "dc-sheet-chip");
      sheetChip.hidden = true;
      identity.append(sheetChip);
      top.append(expand, deviceIcon, identity, cardActions, type, sheetClose);
      // Compact tile, shown instead of the card body in tile view. The open
      // button and the quick action are siblings, never nested buttons.
      const tile = el("div", "dc-tile");
      const tileOpen = el("button", "dc-tile-open");
      tileOpen.type = "button";
      tileOpen.setAttribute("aria-haspopup", "dialog");
      tileOpen.addEventListener("click", () => openSheet(card, tileOpen));
      const tileValue = el("strong", "dc-tile-value");
      const tileState = el("span", "dc-tile-state");
      const tileQuick = el("button", "dc-tile-quick");
      tileQuick.type = "button";
      tileQuick.append(icon("power"));
      tileQuick.addEventListener("click", () => toggleLight());
      // Blind position 0 % is open (up) and 100 % closed (down).
      const tileBlind = el("div", "dc-tile-blind");
      const tileUp = el("button", "dc-tile-step");
      const tileDown = el("button", "dc-tile-step");
      tileUp.type = tileDown.type = "button";
      tileUp.dataset.direction = "up";
      tileDown.dataset.direction = "down";
      tileUp.append(icon("up"));
      tileDown.append(icon("down"));
      tileUp.addEventListener("click", () => moveBlind("up"));
      tileDown.addEventListener("click", () => moveBlind("down"));
      tileBlind.append(tileUp, tileDown);
      card.tileOpen = tileOpen;
      card.tileQuick = tileQuick;
      card.tileState = tileState;
      tile.append(tileOpen, tileValue, tileState, tileQuick, tileBlind);
      const body = el("div", "dc-card-body");
      const states = el("div", "dc-state-line");
      const details = el("details", "dc-details");
      const detailSummary = el("summary", "", "Detalji funkcija");
      const detailsContent = el("div", "dc-details-content");
      details.append(detailSummary, detailsContent);
      const commandStatus = el("p", "dc-command-status");
      commandStatus.setAttribute("role", "status");
      commandStatus.setAttribute("aria-live", "polite");
      commandStatus.hidden = true;
      // Starts closed; the same element survives updates, so its open state does too.
      const membersPanel = el("details", "dc-group-members");
      const membersSummary = el("summary", "");
      const membersList = el("div", "dc-group-member-list");
      membersPanel.append(membersSummary, membersList);
      membersPanel.hidden = true;
      card.setMembers = (nodes) => {
        membersPanel.hidden = nodes.length === 0;
        const text = `${card.device.type === "zone" ? "Senzori u zoni" : "Svjetla u grupi"} (${nodes.length})`;
        if (membersSummary.textContent !== text) membersSummary.textContent = text;
        for (let index = 0; index < nodes.length; index++) {
          if (membersList.children[index] !== nodes[index]) membersList.insertBefore(nodes[index], membersList.children[index] || null);
        }
        while (membersList.children.length > nodes.length) membersList.children[nodes.length].remove();
      };
      node.append(selectionLabel, top, tile, body, states, commandStatus, refreshStatus, details, membersPanel);

      const pointFor = (role) => card.device.roles?.[role];
      const draftKey = (role) => `${card.device.key}\u0000${role}`;
      const simulatedValue = (role) => drafts.has(draftKey(role)) ? drafts.get(draftKey(role)) : pointFor(role)?.value;
      const pending = () => commands.get(card.device.key)?.status === "pending";
      const actionLabel = () => demoMode ? "simulacija" : "šalje naredbu kontroleru";
      // Drafts and commands belong to the device, so every row of it shows them.
      const updateInstances = () => { for (const instance of instancesOf(card.device.key)) instance.update(instance.device); };
      const allowed = (role) => {
        const point = pointFor(role);
        return canControl(card.device) && connection === "connected" && !pending() && point?.controlAvailable === true && !point?.error && Number(point?.state) === 0
          && (demoMode || point.writeAllowed === true && point.liveControlAvailable === true && typeof onWrite === "function");
      };
      const disabledReason = (role) => pending() ? "Naredba se šalje. Pričekaj odgovor kontrolera."
        : connection !== "connected" ? "Očitanja se trenutačno ne osvježavaju."
          : !demoMode && typeof onWrite !== "function" ? "Slanje naredbi nije povezano."
            : !demoMode && pointFor(role)?.liveDisabledReason ? pointFor(role).liveDisabledReason
              : pointFor(role)?.disabledReason || "Trenutačna vrijednost nije dostupna za upravljanje.";

      function setDraft(role, value) {
        if (!allowed(role)) return;
        if (!demoMode) commands.delete(card.device.key);
        drafts.set(draftKey(role), value);
        reset.hidden = !demoMode;
        updateInstances();
        if (demoMode) announce.textContent = `${card.device.label}: ${roleLabels[role] || "vrijednost"} simulirano ${format(pointFor(role), value)}. Kontroler nije promijenjen.`;
      }

      async function commit(role, value) {
        if (!allowed(role)) return;
        if (demoMode) { setDraft(role, value); return; }
        const point = pointFor(role);
        const command = {
          status: "pending", role, value, pointId: point.sourceId || point.id,
          previousUpdatedAt: point.updatedAt, previousReadAt: latestReadAt, usesReadClock: readClockAvailable,
        };
        commands.set(card.device.key, command);
        drafts.set(draftKey(role), value);
        updateInstances();
        try {
          await onWrite({ widgetId: command.pointId, value });
          if (destroyed || commands.get(card.device.key) !== command) return;
          command.status = "accepted";
          command.acceptedReadAt = readClockAvailable ? latestReadAt : command.previousReadAt;
          command.acceptedPointReadAt = pointFor(role)?.readAt;
        } catch (error) {
          if (destroyed || commands.get(card.device.key) !== command) return;
          command.status = "error";
          command.error = error?.message || "Nije dobiven odgovor o naredbi.";
          drafts.delete(draftKey(role));
          card.forceControlSync = role;
        }
        updateInstances();
      }

      function metric(source, label, large = false) {
        const currentPoint = typeof source === "function" ? source : () => pointFor(source);
        if (!currentPoint()) return;
        const wrapper = el("div", `dc-metric${large ? " dc-metric-main" : ""}`);
        const value = el("strong", "dc-metric-value");
        const caption = el("span", "dc-metric-label");
        wrapper.append(value, caption);
        body.append(wrapper);
        card.bindings.push(() => {
          const point = currentPoint();
          renderReading(value, point);
          caption.textContent = label || point?.metricLabel || roleLabels[point?.role] || point?.label || "Očitanje";
          wrapper.classList.toggle("dc-reading-warning", point?.error || [1, 2, 3, 4].includes(Number(point?.state)));
          value.title = statusName(point);
        });
      }

      function simulationCopy(role, wrap) {
        const text = el("p", "dc-draft-line");
        wrap.append(text);
        card.bindings.push(() => {
          const draft = drafts.has(draftKey(role));
          text.hidden = !draft;
          text.textContent = draft ? `${demoMode ? "Simulirano" : "Odabrana vrijednost"}: ${format(pointFor(role), simulatedValue(role))}` : "";
        });
      }

      function range(role, label) {
        const point = pointFor(role);
        if (!point) return;
        const bounds = point.control;
        if (!bounds || bounds.rangeConfirmed !== true || !Number.isFinite(Number(bounds.min)) || !Number.isFinite(Number(bounds.max))) {
          numberControl(role, label);
          return;
        }
        const wrap = el("div", `dc-control dc-control-${role}`);
        const inputId = `dc-${Math.random().toString(36).slice(2)}`;
        const row = el("div", "dc-control-heading");
        const caption = el("label", "dc-control-label", label);
        caption.htmlFor = inputId;
        const reading = el("output", "dc-control-output");
        reading.htmlFor = inputId;
        const input = el("input", "dc-range");
        input.id = inputId;
        input.type = "range";
        input.min = String(bounds.min);
        input.max = String(bounds.max);
        input.step = String(bounds.step || 1);
        input.addEventListener("input", () => setDraft(role, Number(input.value)));
        input.addEventListener("change", () => { if (!demoMode) void commit(role, Number(input.value)); });
        row.append(caption, reading);
        wrap.append(row, input);
        if (["positionSet", "slatSet"].includes(role) && Number(bounds.min) === 0 && Number(bounds.max) === 100) {
          wrap.append(el("p", "dc-control-hint", "Raspon 0–100 %"));
        }
        simulationCopy(role, wrap);
        body.append(wrap);
        card.bindings.push(() => {
          const current = numeric(simulatedValue(role));
          input.disabled = !allowed(role) || current === null || current < Number(input.min) || current > Number(input.max);
          input.setAttribute("aria-label", `${card.device.label}: ${label}, ${actionLabel()}`);
          input.title = input.disabled ? disabledReason(role) : demoMode ? "Promjena služi za simulaciju." : "Naredba se šalje kada otpustiš klizač.";
          if (document.activeElement !== input || card.forceControlSync === role) input.value = String(current === null ? Number(input.min) : current);
          reading.textContent = format(pointFor(role), simulatedValue(role));
          const percent = current === null ? 0 : Math.max(0, Math.min(100, (current - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100));
          input.style.setProperty("--dc-range-fill", `${percent}%`);
        });
      }

      // The card's switch and the tile's quick button send the same command.
      function toggleLight() {
        const role = "brightnessSet";
        if (!pointFor(role) || !canControl(card.device)) return;
        const current = numeric(simulatedValue(role));
        const maximum = Number(pointFor(role)?.control?.max);
        if (current !== null && Number.isFinite(maximum)) void commit(role, current > 0 ? 0 : maximum);
      }

      // Full travel only when the command's 0–100 % range is confirmed:
      // 0 % opens (raises) the blind and 100 % closes (lowers) it.
      function blindTarget(direction) {
        const control = pointFor("positionSet")?.control;
        if (control?.rangeConfirmed !== true || Number(control.min) !== 0 || Number(control.max) !== 100) return null;
        return direction === "up" ? 0 : 100;
      }

      function moveBlind(direction) {
        if (!pointFor("positionSet") || !canControl(card.device)) return;
        const target = blindTarget(direction);
        if (target !== null) void commit("positionSet", target);
      }

      function lightToggle() {
        const role = "brightnessSet";
        if (!pointFor(role)) return;
        const button = el("button", "dc-toggle");
        button.type = "button";
        const track = el("span", "dc-toggle-track");
        track.append(el("span", "dc-toggle-thumb"));
        const copy = el("span", "dc-toggle-label");
        button.append(copy, track);
        button.addEventListener("click", () => toggleLight());
        body.append(button);
        card.bindings.push(() => {
          const number = numeric(simulatedValue(role));
          const on = number !== null && number > 0;
          copy.textContent = `${on ? "Isključi" : "Uključi"}${demoMode ? " u simulaciji" : ""}`;
          button.disabled = !allowed(role) || number === null || !Number.isFinite(Number(pointFor(role)?.control?.max));
          button.title = button.disabled ? disabledReason(role) : demoMode ? "Simulacija upravljanja svjetlom." : `Šalje zadanu svjetlinu ${on ? 0 : pointFor(role).control.max} % kontroleru.`;
          button.setAttribute("aria-pressed", String(on));
          button.setAttribute("aria-label", `${card.device.label}: ${on ? "isključi" : "uključi"}, ${actionLabel()}`);
        });
      }

      // Preset targets for the sheet, sent through the same command path.
      function presets(role, entries) {
        const point = pointFor(role);
        if (!point || point.control?.rangeConfirmed !== true) return;
        const wrap = el("div", "dc-presets");
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-label", "Brze vrijednosti");
        const buttons = entries.map(([value, text]) => {
          const button = el("button", "dc-preset", text);
          button.type = "button";
          button.addEventListener("click", () => {
            const bounds = pointFor(role)?.control;
            if (bounds && value >= Number(bounds.min) && value <= Number(bounds.max)) void commit(role, value);
          });
          wrap.append(button);
          return [button, value, text];
        });
        body.append(wrap);
        card.bindings.push(() => {
          const current = numeric(simulatedValue(role));
          for (const [button, value, text] of buttons) {
            button.disabled = !allowed(role);
            button.setAttribute("aria-pressed", String(current === value));
            button.setAttribute("aria-label", `${card.device.label}: ${text}, ${actionLabel()}`);
            button.title = button.disabled ? disabledReason(role) : `${text}${demoMode ? " u simulaciji" : ""}`;
          }
        });
      }

      function numberControl(role, label) {
        if (!pointFor(role)) return;
        const wrap = el("div", "dc-control dc-number-control");
        const caption = el("label", "dc-control-label", label);
        const input = el("input", "dc-number");
        input.type = "number";
        input.step = String(pointFor(role)?.control?.step || "any");
        input.setAttribute("aria-label", `${card.device.label}: ${label}`);
        const hint = el("p", "dc-control-hint", "Raspon nije potvrđen; unos služi samo za probu prikaza.");
        input.addEventListener("change", () => {
          const value = numeric(input.value);
          if (value !== null) void commit(role, value);
        });
        caption.append(input);
        wrap.append(caption, hint);
        simulationCopy(role, wrap);
        body.append(wrap);
        card.bindings.push(() => {
          const current = numeric(simulatedValue(role));
          if (document.activeElement !== input || card.forceControlSync === role) input.value = current === null ? "" : String(current);
          input.disabled = !allowed(role) || current === null;
          input.setAttribute("aria-label", `${card.device.label}: ${label}, ${actionLabel()}`);
          input.title = input.disabled ? disabledReason(role) : "";
          hint.textContent = demoMode ? "Raspon nije potvrđen; unos služi samo za probu prikaza." : disabledReason(role);
        });
      }

      function stepper(role, label) {
        if (!pointFor(role)) return;
        const wrap = el("div", "dc-control dc-temperature-control");
        const caption = el("span", "dc-control-label");
        const buttons = el("div", "dc-stepper");
        const down = el("button", "dc-step-button", "−");
        const up = el("button", "dc-step-button", "+");
        down.type = up.type = "button";
        down.setAttribute("aria-label", `${card.device.label}: smanji zadanu temperaturu u simulaciji`);
        up.setAttribute("aria-label", `${card.device.label}: povećaj zadanu temperaturu u simulaciji`);
        const reading = el("output", "dc-setpoint");
        buttons.append(down, reading, up);
        wrap.append(caption, buttons);
        simulationCopy(role, wrap);
        body.append(wrap);
        function target(direction) {
          const current = numeric(simulatedValue(role));
          if (current === null) return null;
          const hints = pointFor(role)?.control || {};
          const next = Number((current + direction * Number(hints.step || 0.5)).toFixed(6));
          if (hints.min !== undefined && next < Number(hints.min) || hints.max !== undefined && next > Number(hints.max)) return null;
          return next;
        }
        down.addEventListener("click", () => { const next = target(-1); if (next !== null) void commit(role, next); });
        up.addEventListener("click", () => { const next = target(1); if (next !== null) void commit(role, next); });
        card.bindings.push(() => {
          caption.textContent = `${label}${demoMode ? " · simulacija" : ""}`;
          down.setAttribute("aria-label", `${card.device.label}: smanji zadanu temperaturu, ${actionLabel()}`);
          up.setAttribute("aria-label", `${card.device.label}: povećaj zadanu temperaturu, ${actionLabel()}`);
          reading.textContent = format(pointFor(role), simulatedValue(role));
          down.disabled = !allowed(role) || target(-1) === null;
          up.disabled = !allowed(role) || target(1) === null;
          down.title = down.disabled ? target(-1) === null ? "Dosegnuta je donja granica zadane temperature." : disabledReason(role) : actionLabel();
          up.title = up.disabled ? target(1) === null ? "Dosegnuta je gornja granica zadane temperature." : disabledReason(role) : actionLabel();
        });
      }

      function selection(role, label) {
        const point = pointFor(role);
        if (!point) return;
        if (!Array.isArray(point.control?.options) || point.control.options.length === 0) { metric(role, label); return; }
        const wrap = el("div", "dc-control dc-select-control");
        const caption = el("label", "dc-control-label");
        const captionText = el("span");
        caption.append(captionText);
        const input = el("select", "dc-select browser-default");
        input.setAttribute("aria-label", `${card.device.label}: ${label}, simulacija`);
        caption.append(input);
        const missing = el("option", "", "Nije očitano");
        missing.value = "";
        missing.disabled = true;
        input.append(missing);
        for (const option of point.control.options) {
          const entry = el("option", "", enumLabel(point, option));
          entry.value = String(option.value);
          input.append(entry);
        }
        input.addEventListener("change", () => {
          const option = pointFor(role)?.control?.options?.find((entry) => String(entry.value) === input.value);
          if (option) void commit(role, option.value);
        });
        wrap.append(caption);
        simulationCopy(role, wrap);
        body.append(wrap);
        card.bindings.push(() => {
          const current = String(simulatedValue(role) ?? "");
          const known = pointFor(role)?.control?.options?.some((entry) => String(entry.value) === current);
          if (document.activeElement !== input || card.forceControlSync === role) input.value = known ? current : "";
          missing.textContent = current && !known ? `Očitano: ${format(pointFor(role))}` : "Nije očitano";
          input.disabled = !allowed(role) || !known;
          captionText.textContent = `${label}${demoMode ? " · simulacija" : ""}`;
          input.setAttribute("aria-label", `${card.device.label}: ${label}, ${actionLabel()}`);
          input.title = input.disabled ? disabledReason(role) : actionLabel();
        });
      }

      function renderBody() {
        body.replaceChildren();
        card.bindings = [];
        const roles = card.device.roles || {};
        if (card.device.metrics) {
          if (card.device.metrics.primary) metric(() => card.device.metrics.primary, null, true);
          card.device.metrics.secondary.forEach((_, index) => metric(() => card.device.metrics.secondary[index]));
        } else if (card.device.type === "light" || card.device.type === "lightGroup") {
          metric(roles.brightnessStatus ? "brightnessStatus" : "brightnessSet", roles.brightnessStatus ? "Očitana svjetlina" : "Očitana zadana svjetlina", true);
        } else if (card.device.type === "climate") {
          metric("temperature", "Temperatura", true);
          metric("humidity");
          metric("co2");
          metric("modeStatus", "Način rada uređaja");
        } else if (card.device.type === "blind") {
          metric(roles.positionStatus ? "positionStatus" : "positionSet", roles.positionStatus ? "Očitani položaj" : "Očitani zadani položaj", true);
        } else if (card.device.type === "sensor" || card.device.type === "zone") {
          metric("illuminance", "Osvijetljenost", true);
          metric("occupancy");
          metric("temperature", "Temperatura", !roles.illuminance);
          metric("humidity");
          metric("co2");
        }
        if (canControl(card.device)) {
          if (card.device.type === "light" || card.device.type === "lightGroup") {
            lightToggle();
            range("brightnessSet", demoMode ? "Svjetlina · simulacija" : "Svjetlina");
            presets("brightnessSet", [[100, "100 %"], [50, "50 %"], [25, "25 %"]]);
          } else if (card.device.type === "climate") {
            stepper("setpoint", "Zadana temperatura");
            selection("modeSet", "Način rada");
            selection("fanSpeed", "Ventilator");
            selection("power", "Napajanje");
          } else if (card.device.type === "blind") {
            range("positionSet", demoMode ? "Položaj · simulacija" : "Položaj");
            if (blindTarget("up") !== null) presets("positionSet", [[0, "Otvori"], [50, "Pola"], [100, "Zatvori"]]);
            range("slatSet", demoMode ? "Kut lamela · simulacija" : "Kut lamela");
          }
        }
        if (!body.childElementCount) {
          const list = el("div", "dc-generic-readings");
          body.append(list);
          const readings = card.device.metrics ? [] : (card.device.primary || []).slice(0, 3);
          for (const original of readings) {
            const row = el("div", "dc-generic-reading");
            const label = el("span", "", original.label);
            const value = el("strong");
            row.append(label, value);
            list.append(row);
            card.bindings.push(() => {
              const point = (card.device.primary || []).find((entry) => entry.id === original.id);
              value.textContent = point?.error ? "—" : format(point);
            });
          }
          if (!readings.length) list.append(el("p", "dc-muted", "Očitanja i svojstva dostupni su u detaljima."));
          if (canControl(card.device)) body.append(el("p", "dc-muted", "Funkcije za upravljanje još nisu prepoznate."));
        }
      }

      // One line of state for the tile, from the same values the card shows.
      function renderTile() {
        const device = card.device;
        const roles = device.roles || {};
        const lightType = device.type === "light" || device.type === "lightGroup";
        const lightRole = roles.brightnessSet ? "brightnessSet" : roles.brightnessStatus ? "brightnessStatus" : null;
        let big = null;
        let text = "";
        let on = null;
        if (lightType && lightRole) {
          const point = pointFor(lightRole);
          const number = numeric(lightRole === "brightnessSet" ? simulatedValue(lightRole) : point?.value);
          on = number === null || point?.error ? null : number > 0;
          text = on === null ? "Stanje nije poznato" : on ? `Uključeno · ${format(point, number)}` : "Isključeno";
        } else if (device.type === "blind") {
          const point = roles.positionStatus || roles.positionSet;
          text = point ? `Položaj ${point.error ? "—" : format(point)}` : typeLabels.blind;
          // A sent or simulated target shows until a reading confirms it.
          if (roles.positionSet && drafts.has(draftKey("positionSet"))) text += ` · cilj ${format(roles.positionSet, simulatedValue("positionSet"))}`;
        } else {
          big = device.metrics?.primary || (device.type === "climate" ? roles.temperature
            : roles.illuminance || roles.temperature || roles.co2 || roles.humidity || roles.occupancy) || null;
          if (!big && device.type === "generic") big = (device.primary || [])[0] || null;
          if (device.type === "climate" && roles.setpoint) text = `Zadano ${format(roles.setpoint, simulatedValue("setpoint"))}`;
          else if (device.type === "climate" && roles.modeStatus) text = format(roles.modeStatus);
          else text = big ? big.metricLabel || roleLabels[big.role] || big.label || typeLabels[device.type] : typeLabels[device.type] || "Uređaj";
        }
        tileValue.hidden = !big;
        if (big) renderReading(tileValue, big); else tileValue.textContent = "";
        const command = commands.get(device.key);
        const failed = command?.status === "error";
        const stateText = command?.status === "pending" ? `${text} · šaljem…` : failed ? "Naredba nije potvrđena" : text;
        if (tileState.textContent !== stateText) tileState.textContent = stateText;
        tileState.classList.toggle("dc-tile-state-error", failed);
        node.classList.toggle("dc-tile-on", on === true);
        const valueText = big ? `${big.error ? "—" : format(big)}, ` : "";
        tileOpen.setAttribute("aria-label", `${device.label}: ${valueText}${stateText}. Otvori upravljanje i detalje.`);
        const quick = Boolean(lightType && roles.brightnessSet && canControl(device));
        tileQuick.hidden = !quick;
        if (quick) {
          const number = numeric(simulatedValue("brightnessSet"));
          tileQuick.disabled = !allowed("brightnessSet") || number === null || !Number.isFinite(Number(roles.brightnessSet.control?.max));
          tileQuick.setAttribute("aria-pressed", String(on === true));
          tileQuick.setAttribute("aria-label", `${device.label}: ${on ? "isključi" : "uključi"}, ${actionLabel()}`);
          tileQuick.title = tileQuick.disabled ? disabledReason("brightnessSet") : `${on ? "Isključi" : "Uključi"}${demoMode ? " u simulaciji" : ""}`;
        }
        const blindQuick = Boolean(device.type === "blind" && roles.positionSet && canControl(device) && blindTarget("up") !== null);
        tileBlind.hidden = !blindQuick;
        if (blindQuick) {
          const blocked = !allowed("positionSet");
          for (const [button, direction] of [[tileUp, "up"], [tileDown, "down"]]) {
            const verb = direction === "up" ? "Podigni (otvori)" : "Spusti (zatvori)";
            button.disabled = blocked;
            button.setAttribute("aria-label", `${device.label}: ${verb.toLowerCase()}, ${actionLabel()}`);
            button.title = blocked ? disabledReason("positionSet") : `${verb}${demoMode ? " u simulaciji" : ""}`;
          }
        }
        const chip = { pending: "Šaljem", accepted: "Prihvaćeno", readback: "Potvrđeno", error: "Nije potvrđeno" }[command?.status] || "";
        sheetChip.hidden = !chip;
        if (sheetChip.textContent !== chip) sheetChip.textContent = chip;
        sheetChip.dataset.status = command?.status || "";
        sheetClose.setAttribute("aria-label", `Zatvori ${device.label}`);
        sheetClose.title = "Zatvori";
      }

      function renderDetails() {
        detailsContent.replaceChildren();
        if (card.device.reason) detailsContent.append(el("p", "dc-detail-reason", card.device.reason));
        if (card.device.room?.source) detailsContent.append(el("p", "dc-detail-room-source", `Izvor prostorije: ${card.device.room.source}`));
        const sections = [["Prikaz i upravljanje", card.device.primary], ["Dijagnostika", card.device.diagnostics], ["Pomoćna svojstva", card.device.support], ["Ostale vrijednosti", card.device.other]];
        const seen = new Set();
        for (const [label, points] of sections) {
          const unique = (points || []).filter((point) => { if (seen.has(point.id)) return false; seen.add(point.id); return true; });
          if (!unique.length) continue;
          detailsContent.append(el("h4", "dc-detail-heading", label));
          const list = el("dl", "dc-point-list");
          for (const point of unique) {
            const term = el("dt", "", roleLabels[point.role] || point.label);
            const value = el("dd", "");
            value.append(el("span", "dc-detail-value", `${rawFormat(point)} · ${statusName(point)}`), el("code", "dc-point-id", point.id));
            if (point.reason) value.append(el("span", "dc-detail-note", point.reason));
            for (const auxiliary of point.auxiliary || []) value.append(el("span", "dc-detail-note", `${auxiliary.label}: ${rawFormat(auxiliary)}`));
            list.append(term, value);
          }
          detailsContent.append(list);
        }
        if (card.device.aliases?.length) detailsContent.append(el("p", "dc-detail-note", `${card.device.aliases.length} grafičkih referenci spojeno je s izvornim vrijednostima.`));
      }

      details.addEventListener("toggle", () => { if (details.open) renderDetails(); });
      card.update = (device) => {
        const oldType = card.device.type;
        card.device = device;
        if (oldType !== device.type) {
          node.className = `card-panel dc-card dc-type-${device.type}`;
          deviceIcon.replaceChildren(icon(device.type));
          type.textContent = typeLabels[device.type] || "Uređaj";
        }
        syncMemberOpen();
        expand.setAttribute("aria-label", `Više o uređaju ${device.label}`);
        expand.title = `Više o uređaju ${device.label}`;
        title.textContent = device.label;
        checkbox.setAttribute("aria-label", `Odaberi uređaj ${device.label} · ${device.key}`);
        settings.hidden = !settingsEnabled || typeof onSettings !== "function";
        settings.setAttribute("aria-label", `Postavke uređaja ${device.label}`);
        settings.title = `Postavke uređaja ${device.label}`;
        refresh.setAttribute("aria-label", `Osvježi uređaj ${device.label}`);
        refresh.title = `Osvježi očitanja uređaja ${device.label}`;
        room.textContent = roomCaption(device.room) || "Prostorija nije dodijeljena";
        room.classList.toggle("dc-room-unknown", !device.room);
        const command = commands.get(device.key);
        const commandedPoint = command && device.roles?.[command.role];
        reconcileCommand(device);
        const signature = JSON.stringify([device.type, demoMode, Object.entries(device.roles || {}).map(([role, point]) => [role, point.id, point.control]), (device.primary || []).map((point) => point.id), device.metrics ? [[device.metrics.primary?.id, device.metrics.primary?.unit, device.metrics.primary?.unitOverridden], device.metrics.secondary.map((point) => point.id)] : null]);
        if (signature !== card.signature) { card.signature = signature; renderBody(); }
        for (const binding of card.bindings) binding();
        card.forceControlSync = null;
        states.replaceChildren();
        const points = [...(device.primary || []), ...(device.diagnostics || []), ...Object.values(device.roles || {}), device.metrics?.primary, ...(device.metrics?.secondary || [])].filter(Boolean);
        const forced = points.some((point) => Number(point.state) === 2);
        const failed = points.some((point) => point.error || [1, 3, 4].includes(Number(point.state)));
        if (connection !== "connected") states.append(el("span", "dc-state dc-state-warning", "Bez svježih očitanja"));
        if (forced) states.append(el("span", "dc-state dc-state-warning", "Forsirano"));
        if (failed) states.append(el("span", "dc-state dc-state-warning", "Provjeri stanje"));
        if (demoMode && [...drafts.keys()].some((key) => key.startsWith(`${device.key}\u0000`))) states.append(el("span", "dc-state dc-state-simulated", "Lokalna simulacija"));
        if (command?.status === "pending") states.append(el("span", "dc-state dc-state-pending", "Slanje naredbe"));
        states.hidden = !states.childElementCount;
        node.setAttribute("aria-busy", String(command?.status === "pending"));
        commandStatus.hidden = !command;
        commandStatus.classList.toggle("dc-command-error", command?.status === "error");
        if (command) {
          const target = `${roleLabels[command.role] || "Vrijednost"}: ${format(commandedPoint, command.value)}`;
          commandStatus.textContent = command.status === "pending" ? `Šaljem naredbu. ${target}.`
            : command.status === "accepted" ? `Naredba je prihvaćena. ${target}. Čekam novo očitanje zadane vrijednosti.`
              : command.status === "readback" ? `Zadana vrijednost potvrđena je novim očitanjem. ${target}.`
                : `Slanje nije potvrđeno: ${command.error} Provjeri očitanja prije novog pokušaja.`;
        } else commandStatus.textContent = "";
        renderTile();
        if (details.open) renderDetails();
      };
      card.update(initial);
      return card;
    }

    function update({ widgets = [], status = "idle", metadataById = {}, roomByZone = {}, deviceSettings = [], roomRules = [], rooms = [], floors: savedFloors = [], roomDetails = [], roomEditingEnabled: roomsEnabled = false, demo = false, warnings = [], readAt, syncedAt, settingsEnabled: editingEnabled = false } = {}) {
      if (destroyed) return;
      settingsEnabled = editingEnabled === true;
      roomEditingEnabled = roomsEnabled === true;
      registeredRooms = Array.isArray(rooms) ? rooms : [];
      registeredFloors = Array.isArray(savedFloors) ? savedFloors : [];
      roomDefinitions = Array.isArray(roomDetails) ? roomDetails : [];
      if (!roomEditingEnabled) { selectionMode = false; selectedKeys.clear(); }
      if (demoMode !== Boolean(demo)) { drafts.clear(); commands.clear(); }
      demoMode = Boolean(demo);
      readClockAvailable = readAt !== undefined || syncedAt !== undefined;
      latestReadAt = readAt !== undefined ? readAt : syncedAt;
      connection = typeof status === "string" ? status : status?.status || status?.state || "idle";
      const hasControl = !readOnly || controlDeviceKeys.size > 0;
      simulationBadge.textContent = !hasControl ? "Samo pregled" : demoMode ? "Simulacija upravljanja" : "Stvarno upravljanje";
      simulationBadge.classList.toggle("dc-live-badge", hasControl && !demoMode);
      simulationBadge.title = !hasControl ? "" : demoMode ? "Kontrole mijenjaju samo lokalnu simulaciju." : "Aktivne kontrole mijenjaju stvarne uređaje u zgradi.";
      const warningTexts = (Array.isArray(warnings) ? warnings : []).filter((warning) => typeof warning === "string" && warning.trim());
      readWarning.hidden = warningTexts.length === 0;
      readWarning.textContent = warningTexts[0] || "";
      readWarning.title = warningTexts.join("\n");
      const modelOptions = { metadataById, roomByZone, deviceSettings, roomRules, floors: registeredFloors, roomDetails: roomDefinitions };
      deviceIndex = globalThis.IoTDeviceModel?.createDeviceIndex?.(widgets, modelOptions) || null;
      const result = deviceIndex ? deviceIndex.getDevices() : globalThis.IoTDeviceModel?.buildDevices(widgets, modelOptions);
      devices = Array.isArray(result) ? result : result?.devices || [];
      devicePositions = new Map(devices.map((device, index) => [device.key, index]));
      devicesByKey = new Map(devices.map((device) => [device.key, device]));
      computeDisplayOrder();
      savedSettings = Array.isArray(deviceSettings) ? deviceSettings : [];
      memberParents = groupMembership();
      searchIndex = new Map(devices.map((device) => [device.key, searchText([device.label, device.key, device.context, roomCaption(device.room)].filter(Boolean).join(" "))]));
      const present = new Set(devices.map((device) => device.key));
      for (const key of selectedKeys) if (!present.has(key)) selectedKeys.delete(key);
      for (const [key, card] of cards) {
        if (!present.has(key)) { card.node.remove(); cards.delete(key); commands.delete(key); }
      }
      for (const [key, byParent] of mirrors) {
        for (const [parent, mirror] of byParent) {
          if (!present.has(key) || !(memberParents.get(key) || []).includes(parent)) { mirror.node.remove(); byParent.delete(parent); }
        }
        if (!byParent.size) mirrors.delete(key);
      }
      for (const key of drafts.keys()) if (!present.has(key.split("\u0000")[0])) drafts.delete(key);
      reset.hidden = !demoMode || drafts.size === 0;
      for (const device of devices) updateCard(device);
      reset.hidden = !demoMode || drafts.size === 0;
      updateFilters();
      applyFilter();
    }

    function updateValues({ widgets = [], status = connection, readAt, syncedAt } = {}) {
      if (destroyed || !deviceIndex) return { changedDevices: 0, updatedCards: 0 };
      const nextConnection = typeof status === "string" ? status : status?.status || status?.state || connection;
      const connectionChanged = nextConnection !== connection;
      connection = nextConnection;
      const nextReadAt = readAt !== undefined ? readAt : syncedAt;
      const readChanged = nextReadAt !== undefined && nextReadAt !== latestReadAt;
      if (nextReadAt !== undefined) { latestReadAt = nextReadAt; readClockAvailable = true; }
      const changed = deviceIndex.updateValues(widgets);
      const dirty = new Set();
      let filtersChanged = false;
      for (const device of changed) {
        const previous = devicesByKey.get(device.key);
        if (!previous) continue;
        devices[devicePositions.get(device.key)] = device;
        devicesByKey.set(device.key, device);
        dirty.add(device.key);
        if (previous.label !== device.label || previous.context !== device.context || previous.type !== device.type || JSON.stringify(previous.room) !== JSON.stringify(device.room)) {
          filtersChanged = true;
          searchIndex.set(device.key, searchText([device.label, device.key, device.context, roomCaption(device.room)].filter(Boolean).join(" ")));
        }
      }
      if (readChanged) for (const key of commands.keys()) {
        const device = devicesByKey.get(key);
        if (device && reconcileCommand(device)) dirty.add(key);
      }
      if (connectionChanged) for (const card of allCards()) {
        if (card.node.hidden) card.needsRefresh = true;
        else dirty.add(card.device.key);
      }
      let updatedCards = 0;
      for (const key of dirty) if (updateCard(devicesByKey.get(key))) updatedCards++;
      if (filtersChanged) { memberParents = groupMembership(); computeDisplayOrder(); updateFilters(); applyFilter(); }
      else if (connectionChanged) updateSummary();
      return { changedDevices: changed.length, updatedCards };
    }

    update();
    return { update, updateValues, getDevices() { return devices.slice(); },
      clearSelection(message = "") {
        selectedKeys.clear(); selectionMode = false; applyFilter();
        managementStatus.textContent = message; managementStatus.hidden = !message;
      },
      destroy() { closeSheet(); destroyed = true; scrollObserver?.disconnect(); drafts.clear(); commands.clear(); refreshes.clear(); cards.clear(); mirrors.clear(); selectedKeys.clear(); devices = []; displayOrder = []; headings.clear(); deviceIndex = null; devicePositions.clear(); devicesByKey.clear(); searchIndex.clear(); container.replaceChildren(); } };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.IoTDeviceCards = api;
})();
