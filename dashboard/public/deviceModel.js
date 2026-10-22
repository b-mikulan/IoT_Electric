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
    BlndSlt: ["slatSet", "primary", "Zadani kut lamela", true],
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
    const definition = functionPath && Object.hasOwn(definitions, token) ? definitions[token] : null;
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
    const displayUnit = !unit && ["positionSet", "positionStatus", "slatSet"].includes(classification.role) ? "%" : unit;
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
      if (["positionSet", "slatSet"].includes(classification.role)) {
        control = { kind: "range", min: 0, max: 100, step: 1, rangeConfirmed: true, rangeSource: "user-confirmed" };
      }
      if (classification.role === "setpoint" && unitKnown) {
        // Dashboard test policy, not limits discovered from EWS. The controller
        // can still reject a setpoint within this intentionally bounded range.
        const limits = /^°F$/i.test(unit) ? [41, 95] : /^K$/i.test(unit) ? [278.15, 308.15] : [5, 35];
        control = { kind: "number", min: limits[0], max: limits[1], step: 0.5, rangeConfirmed: true, rangeSource: "dashboard-policy" };
      }
    }
    const disabledReason = !classification.command ? "Očitanje ili pomoćni podatak; nije korisnička naredba."
      : !serverWriteable ? "Server nije potvrdio da se vrijednost može postavljati."
        : widget.error ? "Očitanje ima grešku."
          : state === 2 ? "Vrijednost je forsirana (Forced)."
            : state !== 0 ? "Stanje vrijednosti nije Good."
              : !unitKnown ? "Mjerna jedinica naredbe nije potvrđena."
                : !enumKnown ? "Dopuštene opcije upravljanja nisu potvrđene."
                  : !valueKnown ? "Trenutačno očitanje nije valjana vrijednost naredbe." : null;
    const explicitServerPermission = hasFlag(metadata.writeable ?? metadata.writable) && flag(metadata.writeable ?? metadata.writable);
    const nativeCommand = String(widget.id || "").startsWith("01/");
    const liveControlAvailable = controlAvailable && explicitServerPermission && nativeCommand && control?.rangeConfirmed === true;
    const liveDisabledReason = disabledReason
      || (!nativeCommand ? "Stvarno upravljanje koristi samo izvornu 01 točku; referenca se ne zapisuje."
        : !explicitServerPermission ? "Za stvarni upis potrebna je izričita dozvola servera Writeable."
          : control?.rangeConfirmed !== true ? "Raspon ove naredbe nije potvrđen; stvarni upis nije omogućen."
            : !flag(widget.writable) ? "Upis nije uključen u postavkama ove točke." : null);
    return {
      id: String(widget.id || ""), label: classification.label, configuredLabel: widget.label || metadata.name || null,
      value: widget.value, state, error: widget.error || null, unit: displayUnit, updatedAt: widget.updatedAt || null,
      role: classification.role, importance: classification.importance, reason: classification.reason,
      metadata: normalizedMetadata, command: classification.command, control, controlAvailable,
      writeAllowed: controlAvailable && flag(widget.writable), disabledReason,
      liveControlAvailable, liveDisabledReason,
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

  function defaultMetricIds(device) {
    const roles = device.roles;
    let primary = null;
    let secondary = [];
    if (["light", "lightGroup"].includes(device.type)) primary = roles.brightnessStatus || roles.brightnessSet;
    else if (device.type === "climate") {
      primary = roles.temperature;
      secondary = [roles.humidity, roles.co2, roles.modeStatus];
    } else if (device.type === "blind") primary = roles.positionStatus || roles.positionSet;
    else if (["sensor", "zone"].includes(device.type)) {
      primary = roles.illuminance || roles.temperature;
      secondary = [roles.occupancy, roles.temperature, roles.humidity, roles.co2].filter((point) => point !== primary);
    } else secondary = device.primary.slice(0, 3);
    return { primaryPointId: primary?.id || null, secondaryPointIds: secondary.filter(Boolean).map((point) => point.id) };
  }

  function displayMetric(point, id, automatic = false) {
    if (!point) return {
      id, label: "Odabrano očitanje nije dostupno", metricLabel: "Odabrano očitanje nije dostupno",
      value: null, state: null, error: "Točka više nije dostupna među prikazanim vrijednostima.", unit: "",
      role: "unknown", importance: "other", metadata: {}, missing: true, auxiliary: [],
      command: false, control: null, controlAvailable: false, writeAllowed: false, liveControlAvailable: false,
    };
    const defaultCaptions = {
      brightnessSet: "Očitana zadana svjetlina", brightnessStatus: "Očitana svjetlina",
      positionSet: "Očitani zadani položaj", positionStatus: "Očitani položaj", modeStatus: "Način rada uređaja",
    };
    // A selected metric is always a display. Its source can be a command point,
    // but choosing it never adds or moves a control to another device.
    return {
      ...point, metricLabel: automatic ? defaultCaptions[point.role] || point.label : point.label,
      unit: point.unit || (point.role === "brightnessSet" && point.control?.rangeConfirmed === true && point.control.min === 0 && point.control.max === 100 ? "%" : ""),
      command: false, control: null, controlAvailable: false, writeAllowed: false, liveControlAvailable: false,
    };
  }

  function buildDevices(widgets, { metadataById = {}, roomByZone = {}, deviceSettings = [] } = {}) {
    const known = new Map((Array.isArray(widgets) ? widgets : []).filter((widget) => widget?.id).map((widget) => [String(widget.id), widget]));
    const byPath = new Map();
    for (const id of [...known.keys(), ...Object.keys(metadataById)]) {
      if (!id.startsWith("11/") && objectPath(id) !== null) byPath.set(objectPath(id), id);
    }
    const devices = new Map();
    const activePoints = new Map();
    const visiblePoints = new Map();
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
          visiblePoints.set(id, point);
          if (known.get(candidate).visible !== false) continue;
          // A visible reference can represent the function while its source
          // widget stays hidden. Its own live state and permissions apply.
        } else {
          point.role = "unknown";
          point.importance = "other";
          point.command = false;
          point.controlAvailable = false;
          point.writeAllowed = false;
          point.liveControlAvailable = false;
          point.reason = "Value referenca bez pronađene osnovne točke; veza nije potvrđena.";
        }
      }
      visiblePoints.set(id, point);
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
    const settingsByKey = new Map((Array.isArray(deviceSettings) ? deviceSettings : []).filter((entry) => entry && typeof entry.key === "string").map((entry) => [entry.key, entry]));
    for (const device of devices.values()) {
      for (const point of device.primary.filter((item) => item.command)) {
        const matches = device.primary.filter((item) => item.command && item.role === point.role);
        if (matches.length > 1) {
          point.roleAmbiguous = true;
          point.liveControlAvailable = false;
          point.liveDisabledReason = "Više naredbenih točaka ima istu ulogu na ovoj kartici; potrebno je ručno odabrati izvor.";
        }
      }
      device.type = deviceType(device);
      device.automaticLabel = device.label;
      device.automaticRoom = device.room;
      device.defaultMetrics = defaultMetricIds(device);
      const settings = settingsByKey.get(device.key) || {};
      if (typeof settings.label === "string" && settings.label.trim()) device.label = settings.label.trim();
      if (typeof settings.room === "string") device.room = settings.room.trim() ? { label: settings.room.trim(), source: "Ručno dodijeljena prostorija" } : null;
      const primaryId = typeof settings.primaryPointId === "string" ? settings.primaryPointId : device.defaultMetrics.primaryPointId;
      const secondaryIds = Array.isArray(settings.secondaryPointIds) ? [...new Set(settings.secondaryPointIds)] : device.defaultMetrics.secondaryPointIds;
      device.metrics = {
        primary: primaryId ? displayMetric(visiblePoints.get(primaryId), primaryId, settings.primaryPointId == null) : null,
        // Older settings may reference another owner. Keep those out of this
        // card while preserving unavailable references to its own points.
        secondary: secondaryIds.filter((id) => id !== primaryId && grouping.deriveWidgetGrouping(id).key === device.key)
          .map((id) => displayMetric(visiblePoints.get(id), id, settings.secondaryPointIds == null)),
      };
      const automaticUnit = device.metrics.primary?.unit || "";
      device.primaryAutomaticUnit = device.metrics.primary?.role === "humidity" && /^%\s*RH$/i.test(automaticUnit) ? "%" : automaticUnit;
      if (device.metrics.primary && typeof settings.primaryUnit === "string") {
        // This is a display suffix only. Never alter source metadata, numeric
        // values or the command points used for ranges and controller writes.
        device.metrics.primary.unit = settings.primaryUnit.trim();
        device.metrics.primary.unitOverridden = true;
      }
      device.reason += " Funkcije točaka određuju tip kartice; writeable samo po sebi ne određuje namjenu.";
      delete device.groupingKind;
    }
    return [...devices.values()];
  }

  function validateDeviceCommand(point, value) {
    const denied = (reason, code = "INVALID_DEVICE_VALUE") => ({ allowed: false, reason, code });
    if (!point?.writeAllowed || !point.liveControlAvailable || point.roleAmbiguous) {
      return denied(point?.liveDisabledReason || "Ova točka nije dostupna za stvarno upravljanje.", "DEVICE_CONTROL_UNAVAILABLE");
    }
    const control = point.control;
    if (control.options?.length) {
      if (!["string", "number", "boolean"].includes(typeof value)) return denied("Odaberi jednu od potvrđenih opcija.");
      const option = control.options.find((entry) => String(entry.value) === String(value));
      return option ? { allowed: true, value: option.value } : denied("Odabrana opcija nije u popisu koji je vratio kontroler.");
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return denied("Naredba mora sadržavati konačan broj.");
    if (!Number.isFinite(control.min) || !Number.isFinite(control.max) || value < control.min || value > control.max) {
      return denied(`Vrijednost mora biti između ${control.min} i ${control.max} ${point.unit || ""}.`.trim());
    }
    return { allowed: true, value };
  }

  const api = { buildDevices, classifyPoint, normalizePoint, validateDeviceCommand };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.IoTDeviceModel = api;
})();
