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
    let unit = point?.unit || "";
    if (!point?.unitOverridden && point?.role === "humidity" && /^%\s*RH$/i.test(unit)) unit = "%";
    if (!point?.unitOverridden && point?.role === "brightnessSet" && !unit && point?.control?.rangeConfirmed === true && Number(point.control.min) === 0 && Number(point.control.max) === 100) unit = "%";
    return `${text}${unit ? ` ${unit}` : ""}`;
  }

  function statusName(point) {
    if (point?.error) return "Nedostupno";
    return ({ 0: "U redu", 1: "Nesigurno očitanje", 2: "Forsirano", 3: "Izvan mreže", 4: "Greška" })[String(point?.state)] || "Stanje nije poznato";
  }

  function create({ container, onWrite, onSettings, onRooms, onMove }) {
    if (!container || typeof container.append !== "function") throw new TypeError("Device cards need a DOM container.");
    const cards = new Map();
    const drafts = new Map();
    const commands = new Map();
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

    container.classList.add("device-cards-section");
    const headerActions = el("div", "dc-header-actions");
    const simulationBadge = el("span", "chip dc-simulation-badge", "Simulacija upravljanja");
    const reset = el("button", "dc-reset", "Vrati simulaciju");
    reset.type = "button";
    reset.hidden = true;
    reset.addEventListener("click", () => {
      drafts.clear();
      for (const card of cards.values()) card.update(card.device);
      reset.hidden = true;
      announce.textContent = "Simulacija je vraćena na trenutačna očitanja.";
    });
    headerActions.append(simulationBadge, reset);
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
    const announce = el("div", "dc-sr-only");
    announce.setAttribute("role", "status");
    announce.setAttribute("aria-live", "polite");
    container.replaceChildren(searchTools, management, selectionActions, managementStatus, roomPanel, summary, readWarning, grid, loadMore, empty, announce);
    const scrollObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loadMore.hidden) showMore();
    }, { rootMargin: "0px 0px 500px 0px" }) : null;
    scrollObserver?.observe(loadMore);

    function roomKey(device) {
      return roomId(device.room) ? `room:${roomId(device.room)}` : "unassigned";
    }

    function floorLabel(key) { return floorNames.get(key) || "Kat nije određen"; }

    function searchText(value) {
      return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("hr");
    }

    function updateSummary() {
      const count = filteredDevices.length;
      const shown = Math.min(count, displayLimit);
      summary.textContent = devices.length ? `${count === devices.length ? count : `${count} od ${devices.length}`} kartica uređaja${shown < count ? ` · prikazano ${shown}` : ""}${connection !== "connected" ? " · Očitanja se trenutačno ne osvježavaju" : ""}` : "";
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
      const card = cards.get(device.key);
      if (!card) return false;
      for (const [role, previousPoint] of Object.entries(card.device.roles || {})) {
        const nextPoint = device.roles?.[role];
        if (!nextPoint?.control || (previousPoint.sourceId || previousPoint.id) !== (nextPoint.sourceId || nextPoint.id)) {
          drafts.delete(`${device.key}\u0000${role}`);
          if (commands.get(device.key)?.role === role) commands.delete(device.key);
        }
      }
      if (card.node.hidden) { card.device = device; card.needsRefresh = true; return false; }
      card.update(device);
      return true;
    }

    function showMore() {
      if (destroyed || displayLimit >= filteredDevices.length) return;
      displayLimit += CARD_BATCH_SIZE;
      applyFilter();
    }

    function applyFilter() {
      const query = searchText(search.value.trim());
      const signature = JSON.stringify([query, selectedFloor, selectedRoom, typeFilter.value]);
      if (signature !== filterSignature) { filterSignature = signature; displayLimit = CARD_BATCH_SIZE; }
      filteredDevices = devices.filter((device) => (selectedRoom === "all" || roomKey(device) === selectedRoom)
        && (selectedFloor === "all" || device.room && (device.room.floorId || "unknown") === selectedFloor)
        && (typeFilter.value === "all" || device.type === typeFilter.value) && searchIndex.get(device.key)?.includes(query));
      const count = filteredDevices.length;
      const shownDevices = filteredDevices.slice(0, displayLimit);
      const shownKeys = new Set(shownDevices.map((device) => device.key));
      for (const device of shownDevices) {
        if (!cards.has(device.key)) cards.set(device.key, makeCard(device));
        const card = cards.get(device.key);
        if (card.needsRefresh) { card.update(device); card.needsRefresh = false; }
      }
      for (const card of cards.values()) {
        const device = card.device;
        const shown = shownKeys.has(device.key);
        card.node.hidden = !shown;
        if (!shown) card.node.remove();
        card.selection.hidden = !selectionMode;
        card.checkbox.checked = selectedKeys.has(device.key);
        card.node.classList.toggle("dc-card-selected", selectedKeys.has(device.key));
      }
      // Moving existing nodes preserves focused controls and their drafts.
      // Only the requested slice belongs to the live grid.
      for (let index = 0; index < shownDevices.length; index++) {
        const node = cards.get(shownDevices[index].key).node;
        if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
      }
      loadMore.hidden = shownDevices.length >= count;
      loadCount.textContent = `Prikazano ${shownDevices.length} od ${count} uređaja`;
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
      identity.append(title, room);
      const settings = el("button", "dc-settings-button");
      settings.type = "button";
      settings.hidden = true;
      settings.setAttribute("aria-haspopup", "dialog");
      settings.append(icon("settings"));
      settings.addEventListener("click", () => {
        if (!destroyed && settingsEnabled && typeof onSettings === "function") onSettings(card.device);
      });
      const type = el("span", "dc-type-label", typeLabels[initial.type] || "Uređaj");
      top.append(deviceIcon, identity, settings, type);
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
      node.append(selectionLabel, top, body, states, commandStatus, details);

      const pointFor = (role) => card.device.roles?.[role];
      const draftKey = (role) => `${card.device.key}\u0000${role}`;
      const simulatedValue = (role) => drafts.has(draftKey(role)) ? drafts.get(draftKey(role)) : pointFor(role)?.value;
      const pending = () => commands.get(card.device.key)?.status === "pending";
      const actionLabel = () => demoMode ? "simulacija" : "šalje naredbu kontroleru";
      const allowed = (role) => {
        const point = pointFor(role);
        return connection === "connected" && !pending() && point?.controlAvailable === true && !point?.error && Number(point?.state) === 0
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
        card.update(card.device);
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
        card.update(card.device);
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
        if (cards.get(card.device.key) === card) card.update(card.device);
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
          value.textContent = point?.error ? "—" : format(point);
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
        const wrap = el("div", "dc-control");
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

      function lightToggle() {
        const role = "brightnessSet";
        if (!pointFor(role)) return;
        const button = el("button", "dc-toggle");
        button.type = "button";
        const track = el("span", "dc-toggle-track");
        track.append(el("span", "dc-toggle-thumb"));
        const copy = el("span", "dc-toggle-label");
        button.append(copy, track);
        button.addEventListener("click", () => {
          const current = numeric(simulatedValue(role));
          const maximum = Number(pointFor(role)?.control?.max);
          if (current !== null && Number.isFinite(maximum)) void commit(role, current > 0 ? 0 : maximum);
        });
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
        if (card.device.type === "light" || card.device.type === "lightGroup") {
          lightToggle();
          range("brightnessSet", demoMode ? "Svjetlina · simulacija" : "Svjetlina");
        } else if (card.device.type === "climate") {
          stepper("setpoint", "Zadana temperatura");
          selection("modeSet", "Način rada");
          selection("fanSpeed", "Ventilator");
          selection("power", "Napajanje");
        } else if (card.device.type === "blind") {
          range("positionSet", demoMode ? "Položaj · simulacija" : "Položaj");
          range("slatSet", demoMode ? "Kut lamela · simulacija" : "Kut lamela");
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
          body.append(el("p", "dc-muted", "Funkcije za upravljanje još nisu prepoznate."));
        }
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
        title.textContent = device.label;
        checkbox.setAttribute("aria-label", `Odaberi uređaj ${device.label} · ${device.key}`);
        settings.hidden = !settingsEnabled || typeof onSettings !== "function";
        settings.setAttribute("aria-label", `Postavke uređaja ${device.label}`);
        settings.title = `Postavke uređaja ${device.label}`;
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
      simulationBadge.textContent = demoMode ? "Simulacija upravljanja" : "Stvarno upravljanje";
      simulationBadge.classList.toggle("dc-live-badge", !demoMode);
      simulationBadge.title = demoMode ? "Kontrole mijenjaju samo lokalnu simulaciju." : "Aktivne kontrole mijenjaju stvarne uređaje u stanu.";
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
      searchIndex = new Map(devices.map((device) => [device.key, searchText([device.label, device.key, device.context, roomCaption(device.room)].filter(Boolean).join(" "))]));
      const present = new Set(devices.map((device) => device.key));
      for (const key of selectedKeys) if (!present.has(key)) selectedKeys.delete(key);
      for (const [key, card] of cards) {
        if (!present.has(key)) { card.node.remove(); cards.delete(key); commands.delete(key); }
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
      if (connectionChanged) for (const [key, card] of cards) {
        if (card.node.hidden) card.needsRefresh = true;
        else dirty.add(key);
      }
      let updatedCards = 0;
      for (const key of dirty) if (updateCard(devicesByKey.get(key))) updatedCards++;
      if (filtersChanged) { updateFilters(); applyFilter(); }
      else if (connectionChanged) updateSummary();
      return { changedDevices: changed.length, updatedCards };
    }

    update();
    return { update, updateValues, getDevices() { return devices.slice(); },
      clearSelection(message = "") {
        selectedKeys.clear(); selectionMode = false; applyFilter();
        managementStatus.textContent = message; managementStatus.hidden = !message;
      },
      destroy() { destroyed = true; scrollObserver?.disconnect(); drafts.clear(); commands.clear(); cards.clear(); selectedKeys.clear(); devices = []; deviceIndex = null; devicePositions.clear(); devicesByKey.clear(); searchIndex.clear(); container.replaceChildren(); } };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.IoTDeviceCards = api;
})();
