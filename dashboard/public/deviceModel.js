(function () {
  "use strict";

  const grouping = typeof module !== "undefined" && module.exports
    ? require("./widgetGrouping") : globalThis.IoTWidgetGrouping;

  // These names are observed EBO functions, not a rule that every writeable
  // value is a user control. Unknown functions stay available for review.
  const definitions = {
    LtPct: ["brightnessSet", "primary", "Zadana svjetlina", true],
    GrpPct: ["brightnessSet", "primary", "Zadana svjetlina grupe", true],
    LtVal: ["brightnessStatus", "primary", "Očitana razina rasvjete", false],
    BlndPos: ["positionSet", "primary", "Zadani položaj rolete", true],
    BlndVal: ["positionStatus", "primary", "Očitani položaj rolete", false],
    BlndSlt: ["slatSet", "primary", "Zadani položaj lamela", true],
    BlndAng: ["slatStatus", "primary", "Očitani kut lamela", false],
    BlndSts: ["operatingState", "primary", "Stanje rolete", false],
    BlndBtnUp: ["buttonUp", "other", "Signal tipke gore", false],
    BlndBtnDn: ["buttonDown", "other", "Signal tipke dolje", false],
    RmTmp: ["temperature", "primary", "Temperatura", false],
    RmRh: ["humidity", "primary", "Vlažnost", false],
    RmCO2: ["co2", "primary", "CO₂", false],
    EffSpt: ["setpoint", "primary", "Zadana temperatura", true],
    FanSpd: ["fanSpeed", "primary", "Brzina ventilatora", true],
    OnOffMd: ["power", "primary", "Uključivanje", true],
    SysMdCtrl: ["modeSet", "primary", "Zadani način rada", true],
    SysMdSts: ["modeStatus", "primary", "Trenutačni način rada", false],
    LtLvl: ["illuminance", "primary", "Osvijetljenost", false],
    OccSts: ["occupancy", "primary", "Prisutnost", false],
    DevSta: ["deviceStatus", "diagnostic", "Status uređaja", false],
    IduSts: ["availability", "diagnostic", "Dostupnost jedinice", false],
    DevErr: ["deviceFault", "diagnostic", "Greška uređaja", false],
    EcgFlt: ["driverFault", "diagnostic", "Greška pogonske jedinice", false],
    LtFlt: ["lightFault", "diagnostic", "Greška rasvjete", false],
    FilAlm: ["filterAlarm", "diagnostic", "Alarm filtra", false],
    IduAlm: ["unitAlarm", "diagnostic", "Alarm unutarnje jedinice", false],
    LtCol: ["presentationColor", "other", "Boja prikaza", false],
    DevCol: ["presentationColor", "other", "Boja prikaza", false],
    ScrnCol: ["presentationColor", "other", "Boja prikaza", false],
  };

  const properties = new Set([
    "ActiveCommandPriority", "OutOfService", "Reliability", "TotalRecordCount",
    "EventState", "DeviceProductCode", "DeviceProductRevision", "DeviceVendorName", "Status",
  ]);
  const flag = (value) => value === true || value === 1 || value === "1" || value === "true";
  const hasFlag = (value) => value === true || value === false || value === 1 || value === 0 || ["0", "1", "true", "false"].includes(value);
  const lastSegment = (id) => String(id || "").split("/").at(-1);
  const objectPath = (id) => /^(00|01|02|03|11)\//.test(id) ? id.slice(3) : null;

  function enumOptions(metadata, description) {
    const supplied = metadata.enumValues;
    let options = [];
    if (Array.isArray(supplied)) options = supplied.map((entry) => ({
      value: entry.value ?? entry.Value,
      label: String(entry.label ?? entry.text ?? entry.Text ?? entry.value ?? entry.Value ?? ""),
    })).filter((entry) => entry.value !== undefined);
    else if (supplied && typeof supplied === "object") options = Object.entries(supplied).map(([value, label]) => ({ value, label: String(label) }));
    if (!options.length) {
      const expression = /(-?\d+)\s*=\s*([^,;]+)(?:[,;]|$)/g;
      for (const match of String(description || "").matchAll(expression)) {
        options.push({ value: Number(match[1]), label: match[2].trim() });
      }
    }
    return options;
  }

  function classifyPoint(widget, metadata = {}) {
    const id = String(widget.id || "");
    const tail = lastSegment(id);
    const token = id.startsWith("11/") && tail === "Value" ? id.split("/").at(-2) : tail;
    const description = String(metadata.description ?? widget.description ?? "");
    const unit = String(metadata.unit ?? widget.unit ?? "");
    if (id.startsWith("11/") && properties.has(tail)) return {
      role: tail, importance: "diagnostic", label: tail, command: false,
      reason: "Pomoćno svojstvo izvornog objekta; ne predstavlja zasebnu korisničku naredbu.",
    };
    const functionPath = /^(01|11)\//.test(id) && /\/(Values|Points|External Bindings)\//.test(id);
    const definition = functionPath ? definitions[token] : null;
    if (definition) {
      const [role, importance, label, command] = definition;
      return {
        role, importance, label, command,
        reason: role === "presentationColor"
          ? "Boja grafičkog prikaza; nije potvrđena mogućnost upravljanja RGB rasvjetom."
          : `Uloga je prepoznata iz funkcije ${token}${description ? ` i opisa „${description}”` : ""}.`,
      };
    }
    // Units can identify useful readings, but cannot establish a command.
    const reading = /^(°C|°F|K)$/i.test(unit) ? ["temperature", "Temperatura"]
      : /^(%RH|% RH)$/i.test(unit) ? ["humidity", "Vlažnost"]
        : /^ppm$/i.test(unit) ? ["concentration", "Koncentracija (ppm)"]
          : /^(lx|lux)$/i.test(unit) ? ["illuminance", "Osvijetljenost"] : null;
    if (reading) return {
      role: reading[0], importance: "primary", label: reading[1], command: false,
      reason: `Mjerna jedinica ${unit} prepoznaje očitanje; funkcija upravljanja nije potvrđena.`,
    };
    return {
      role: "unknown", importance: "other", label: widget.label || metadata.name || token || id,
      command: false, reason: "Namjena nije potvrđena; dostupno u detaljima za ručnu provjeru.",
    };
  }

  function normalizePoint(widget, metadata = {}) {
    const classification = classifyPoint(widget, metadata);
    const description = String(metadata.description ?? widget.description ?? "");
    const sourceUnit = String(metadata.unit ?? widget.unit ?? "");
    const unit = /^none$/i.test(sourceUnit) ? "" : sourceUnit;
    const state = widget.state === null || widget.state === undefined || widget.state === ""
      ? null : Number(widget.state);
    const options = enumOptions(metadata, description);
    const normalizedMetadata = { ...metadata, description, unit: sourceUnit };
    if (options.length) normalizedMetadata.enumValues = options;
    const serverWriteable = hasFlag(metadata.writeable ?? metadata.writable)
      ? flag(metadata.writeable ?? metadata.writable) : flag(widget.writable);
    const healthy = state === 0 && !widget.error;
    const unitKnown = classification.role === "setpoint" ? /^(°C|°F|K)$/i.test(unit)
      : classification.role === "brightnessSet" ? /^(|none|%)$/i.test(unit) : true;
    const enumKnown = !["modeSet", "fanSpeed", "power"].includes(classification.role) || options.length > 0;
    const valueKnown = widget.value !== null && widget.value !== undefined && widget.value !== ""
      && (options.length ? options.some((option) => String(option.value) === String(widget.value)) : Number.isFinite(Number(widget.value)));
    const controlAvailable = classification.command && serverWriteable && healthy && unitKnown && enumKnown && valueKnown;
    let control = null;
    if (classification.command) {
      control = options.length ? { kind: classification.role === "power" ? "toggle" : "select", options, rangeConfirmed: true }
        : { kind: "number", rangeConfirmed: false };
      if (classification.role === "brightnessSet") control = { kind: "range", min: 0, max: 100, step: 1, rangeConfirmed: true };
      if (classification.role === "setpoint" && unitKnown) control = { kind: "number", step: 0.5, rangeConfirmed: false };
    }
    const disabledReason = !classification.command ? "Očitanje ili pomoćni podatak; nije korisnička naredba."
      : !serverWriteable ? "Server nije potvrdio da se vrijednost može postavljati."
        : widget.error ? "Očitanje ima grešku."
          : state === 2 ? "Vrijednost je forsirana (Forced)."
            : state !== 0 ? "Stanje vrijednosti nije Good."
              : !unitKnown ? "Mjerna jedinica naredbe nije potvrđena."
                : !enumKnown ? "Dopuštene opcije upravljanja nisu potvrđene."
                  : !valueKnown ? "Trenutačno očitanje nije valjana vrijednost naredbe." : null;
    return {
      id: String(widget.id || ""), label: classification.label, configuredLabel: widget.label || metadata.name || null,
      value: widget.value, state, error: widget.error || null, unit, updatedAt: widget.updatedAt || null,
      role: classification.role, importance: classification.importance, reason: classification.reason,
      metadata: normalizedMetadata, command: classification.command, control, controlAvailable,
      writeAllowed: controlAvailable && flag(widget.writable), disabledReason,
      auxiliary: [],
    };
  }

  function roomForOwner(owner, roomByZone) {
    const match = Object.keys(roomByZone).filter((path) => owner === path || owner.startsWith(`${path}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return null;
    const room = roomByZone[match];
    const label = typeof room === "string" ? room : room?.label;
    return label ? { label: String(label), source: match } : null;
  }

  function metadataForReference(widget, aliasMetadata, sourceWidget, sourceMetadata) {
    const source = {
      description: sourceWidget.description,
      unit: sourceWidget.unit,
      ...sourceMetadata,
    };
    const result = { ...aliasMetadata };
    const description = result.description ?? widget.description;
    if (!description || /^Value$/i.test(String(description).trim())) result.description = source.description || description || "";
    for (const field of ["unit", "type", "enumId"]) {
      if ((result[field] === null || result[field] === undefined || result[field] === "") && source[field] !== undefined) result[field] = source[field];
    }
    if (!enumOptions(result, "").length && enumOptions(source, "").length) result.enumValues = source.enumValues;
    // Runtime state and permissions belong to the visible reference. Inherit
    // only descriptive fields, never its source's Writeable/Forceable flags.
    return result;
  }

  function deviceType(device) {
    if (device.groupingKind === "zone") return "zone";
    const roles = device.roles;
    if (roles.positionSet || roles.positionStatus || roles.slatSet || roles.slatStatus) return "blind";
    if (roles.setpoint || roles.modeSet || roles.fanSpeed || (roles.temperature && roles.power)) return "climate";
    if (roles.brightnessSet || roles.brightnessStatus) return device.primary.some((point) => /\/GrpPct$/.test(point.sourceId || point.id)) ? "lightGroup" : "light";
    if (roles.temperature || roles.humidity || roles.co2 || roles.concentration || roles.illuminance || roles.occupancy) return "sensor";
    return "generic";
  }

  function buildDevices(widgets, { metadataById = {}, roomByZone = {} } = {}) {
    const known = new Map((Array.isArray(widgets) ? widgets : []).filter((widget) => widget?.id).map((widget) => [String(widget.id), widget]));
    const byPath = new Map();
    for (const id of [...known.keys(), ...Object.keys(metadataById)]) {
      if (!id.startsWith("11/") && objectPath(id) !== null) byPath.set(objectPath(id), id);
    }
    const devices = new Map();
    const activePoints = new Map();
    const propertyPoints = [];
    for (const widget of known.values()) {
      if (widget.visible === false) continue;
      const id = String(widget.id);
      const owner = grouping.deriveWidgetGrouping(id);
      if (!devices.has(owner.key)) devices.set(owner.key, {
        key: owner.key, label: owner.label, type: "generic", room: roomForOwner(owner.key, roomByZone),
        context: owner.context, groupingKind: owner.kind, roles: {}, primary: [], diagnostics: [], other: [],
        support: [], aliases: [], pointsCount: 0, reason: "Grupiranje po punoj putanji vlasnika točaka.",
      });
      const device = devices.get(owner.key);
      device.pointsCount += 1;
      const valueReference = id.startsWith("11/") && lastSegment(id) === "Value";
      const candidate = valueReference ? `01/${id.slice(3, -6)}` : null;
      const pointMetadata = candidate && known.has(candidate)
        ? metadataForReference(widget, metadataById[id] || {}, known.get(candidate), metadataById[candidate] || {})
        : metadataById[id] || {};
      const point = normalizePoint(widget, pointMetadata);
      if (valueReference) {
        if (known.has(candidate)) {
          device.aliases.push({ sourceId: candidate, aliasId: id });
          point.sourceId = candidate;
          if (known.get(candidate).visible !== false) continue;
          // A visible reference can represent the function while its source
          // widget stays hidden. Its own live state and permissions apply.
        } else {
          point.role = "unknown";
          point.importance = "other";
          point.command = false;
          point.controlAvailable = false;
          point.writeAllowed = false;
          point.reason = "Value referenca bez pronađene osnovne točke; veza nije potvrđena.";
        }
      }
      if (id.startsWith("11/") && properties.has(lastSegment(id))) {
        point.property = lastSegment(id);
        point.sourcePath = id.slice(3, id.lastIndexOf("/"));
        point.sourceId = byPath.get(point.sourcePath) || null;
        device.support.push(point);
        device.diagnostics.push(point);
        propertyPoints.push(point);
        continue;
      }
      activePoints.set(point.sourceId || id, point);
      if (point.importance === "primary") device.primary.push(point);
      else if (point.importance === "diagnostic") device.diagnostics.push(point);
      else device.other.push(point);
      if (point.role !== "unknown" && !device.roles[point.role]) device.roles[point.role] = point;
    }
    for (const property of propertyPoints) {
      const source = activePoints.get(property.sourceId);
      if (source) source.auxiliary.push(property);
    }
    for (const device of devices.values()) {
      device.type = deviceType(device);
      device.reason += " Funkcije točaka određuju tip kartice; writeable samo po sebi ne određuje namjenu.";
      delete device.groupingKind;
    }
    return [...devices.values()];
  }

  const api = { buildDevices, classifyPoint, normalizePoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.IoTDeviceModel = api;
})();
