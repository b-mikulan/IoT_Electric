const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { buildDevices, normalizePoint, validateDeviceCommand } = require("../public/deviceModel");

const rp = (controller) => `03AS001/[BACnet Interface]/IP Network/${controller}`;
const zone = `${rp("RP32")}/Application/Zones/Z312`;
const light = `${zone}/L3307`;
const ac = `${rp("RP31")}/IO Resources/Modbus/AC309`;
const blind = `${rp("RP31")}/Application/Items/B301`;
const point = (owner, name, extra = {}) => ({ id: `01/${owner}/Values/${name}`, value: 0, state: 0, writable: true, visible: true, ...extra });
const metadata = (id, extra = {}) => ({ [id]: { id, writeable: 1, ...extra } });

test("keeps commands, feedback and diagnostics in one device without treating every writeable value as a control", () => {
  const values = [point(light, "LtPct"), point(light, "LtVal"), point(light, "LtFlt"), point(light, "LtCol", { value: "#42B4E6" }), point(light, "AnythingElse")];
  const [device] = buildDevices(values);
  assert.equal(device.type, "light");
  assert.equal(device.primary.length, 2);
  assert.equal(device.diagnostics.length, 1);
  assert.equal(device.other.length, 2);
  assert.equal(device.roles.brightnessSet.writeAllowed, true);
  assert.equal(device.roles.brightnessStatus.writeAllowed, false);
  assert.equal(device.roles.lightFault.writeAllowed, false);
  assert.equal(device.roles.presentationColor.controlAvailable, false);
  assert.equal(device.other.find((entry) => entry.role === "unknown").writeAllowed, false);
});

test("merges only references whose complete source ID is actually present", () => {
  const source = point(light, "LtPct");
  const alias = { ...source, id: `11/${light}/Values/LtPct/Value`, label: "Plan-L3307.LtPct.Value" };
  const property = { ...source, id: `11/${light}/Values/LtPct/Reliability` };
  const unresolved = { ...source, id: `11/${light}/Values/OtherPct/Value` };
  const [device] = buildDevices([source, alias, property, unresolved]);
  assert.equal(device.primary.length, 1);
  assert.equal(device.pointsCount, 4);
  assert.deepEqual(device.aliases, [{ sourceId: source.id, aliasId: alias.id }]);
  assert.equal(device.roles.brightnessSet.auxiliary[0].id, property.id);
  assert.equal(device.support[0].sourceId, source.id);
  assert.equal(device.support[0].writeAllowed, false);
  assert.equal(device.other[0].id, unresolved.id);
});

test("does not group equal room or device names across controllers without explicit full-path evidence", () => {
  const sensor31 = `${rp("RP31")}/Application/Zones/Z312/S3201`;
  const sensor32 = `${zone}/S3201`;
  const values = [point(sensor31, "LtLvl", { unit: "lx" }), point(sensor32, "LtLvl", { unit: "lx" }), point(ac, "RmTmp", { unit: "°C" }), point(light, "LtPct")];
  const unassigned = buildDevices(values);
  assert.equal(unassigned.length, 4);
  assert.ok(unassigned.every((device) => device.room === null));
  const assigned = buildDevices(values, { roomByZone: { [zone]: "Kitchen" } });
  assert.deepEqual(assigned.find((device) => device.key === light).room, { label: "Kitchen", source: zone });
  assert.equal(assigned.find((device) => device.key === sensor31).room, null);
  assert.equal(assigned.find((device) => device.key === ac).room, null);
});

test("server permissions, state, read errors and dashboard permissions separately govern capabilities", () => {
  const widget = point(light, "LtPct");
  assert.equal(normalizePoint({ ...widget, writable: false }, { writeable: 1 }).controlAvailable, true);
  assert.equal(normalizePoint({ ...widget, writable: false }, { writeable: 1 }).writeAllowed, false);
  assert.equal(normalizePoint(widget, { writeable: 0 }).controlAvailable, false);
  for (const state of [null, undefined, "", 1, 2, 3, 4, "invalid"]) {
    assert.equal(normalizePoint({ ...widget, state }, { writeable: 1 }).controlAvailable, false);
  }
  assert.match(normalizePoint({ ...widget, state: 2 }, { writeable: 1 }).disabledReason, /Forced/);
  assert.equal(normalizePoint({ ...widget, error: "Offline" }, { writeable: 1 }).controlAvailable, false);
  assert.equal(normalizePoint({ ...widget, value: "bad" }, { writeable: 1 }).controlAvailable, false);
  assert.equal(normalizePoint(widget, { writeable: 1, unit: "W" }).controlAvailable, false);
});

test("uses described mode and fan options and never makes a status point a mode control", () => {
  const mode = point(ac, "SysMdCtrl", { value: 4 });
  const status = point(ac, "SysMdSts", { value: 1 });
  const fan = point(ac, "FanSpd", { value: 0 });
  const descriptors = {
    ...metadata(mode.id, { description: "System mode control: 0=Heat, 1=Cool, 2=Fan, 3=Dry, 4=Auto" }),
    ...metadata(status.id, { description: "System mode status: 0=Heat, 1=Cool, 2=Fan, 3=Dry, 4=Auto(Heat), 5=Auto(Cool)" }),
    ...metadata(fan.id, { description: "Fan speed: 0=Auto, 1=High, 2=Med, 3=Low" }),
  };
  const [device] = buildDevices([mode, status, fan], { metadataById: descriptors });
  assert.equal(device.type, "climate");
  assert.equal(device.roles.modeSet.control.options.at(-1).label, "Auto");
  assert.equal(device.roles.modeStatus.metadata.enumValues.at(-1).label, "Auto(Cool)");
  assert.equal(device.roles.modeStatus.controlAvailable, false);
  assert.equal(device.roles.fanSpeed.control.options[1].label, "High");
  assert.equal(normalizePoint(mode).controlAvailable, false);
});

test("requires temperature units and uses confirmed blind and slat scales without scaling feedback", () => {
  const setpoint = point(ac, "EffSpt", { value: 23.5 });
  assert.equal(normalizePoint(setpoint).controlAvailable, false);
  assert.equal(normalizePoint(setpoint, { writeable: 1, unit: "°C" }).controlAvailable, true);
  const values = [point(blind, "BlndPos"), point(blind, "BlndVal", { value: 0.36 }), point(blind, "BlndSlt"), point(blind, "BlndAng", { value: 18 }), point(blind, "BlndBtnUp")];
  const [device] = buildDevices(values);
  assert.equal(device.type, "blind");
  assert.deepEqual(device.roles.positionSet.control, { kind: "range", min: 0, max: 1, step: 0.01, rangeConfirmed: true, rangeSource: "user-confirmed" });
  assert.equal(device.roles.positionStatus.value, 0.36);
  assert.equal(device.roles.positionStatus.writeAllowed, false);
  assert.deepEqual(device.roles.slatSet.control, device.roles.positionSet.control);
  assert.equal(device.roles.slatStatus.value, 18);
  assert.equal(device.roles.buttonUp.writeAllowed, false);
});

test("cleans display-only unit markers while retaining the server unit in metadata", () => {
  const normalized = normalizePoint(point(ac, "SysMdSts", { value: 1, unit: "none" }));
  assert.equal(normalized.unit, "");
  assert.equal(normalized.metadata.unit, "none");
  const measured = normalizePoint(point(ac, "RmTmp", { value: 22, unit: "°C" }));
  assert.equal(measured.unit, "°C");
});

test("unknown ppm readings identify concentration without inventing a CO2 sensor or a command", () => {
  assert.equal(normalizePoint(point(ac, "constructor")).role, "unknown");
  const unknown = point(ac, "UnspecifiedGas", { value: 5, unit: "ppm" });
  const co2 = point(ac, "RmCO2", { value: 500, unit: "ppm" });
  assert.equal(normalizePoint(unknown).role, "concentration");
  assert.equal(normalizePoint(unknown).writeAllowed, false);
  assert.equal(normalizePoint(co2).role, "co2");
  assert.equal(buildDevices([unknown])[0].type, "sensor");
  const outsideFunctionFolder = { id: `01/${ac}/Documentation/LtPct`, value: 40, state: 0, writable: true };
  assert.equal(normalizePoint(outsideFunctionFolder).role, "unknown");
  assert.equal(normalizePoint(outsideFunctionFolder).controlAvailable, false);
});

test("respects hidden devices and can retain a visible reference without restoring its hidden source widget", () => {
  const source = point(light, "LtPct", { visible: false });
  assert.deepEqual(buildDevices([source]), []);
  const alias = { ...source, id: `11/${light}/Values/LtPct/Value`, visible: true, writable: false };
  const [device] = buildDevices([source, alias]);
  assert.equal(device.pointsCount, 1);
  assert.equal(device.primary[0].id, alias.id);
  assert.equal(device.primary[0].sourceId, source.id);
  assert.equal(device.primary[0].writeAllowed, false);
});

test("a visible Value reference inherits hidden source descriptions without inheriting its state or permissions", () => {
  const source = point(ac, "FanSpd", { visible: false, value: 3 });
  const alias = { ...source, id: `11/${ac}/Values/FanSpd/Value`, visible: true, value: 0 };
  const descriptions = {
    ...metadata(source.id, { description: "Fan speed: 0=Auto, 1=High, 2=Med, 3=Low" }),
    ...metadata(alias.id, { description: "Value" }),
  };
  const [device] = buildDevices([source, alias], { metadataById: descriptions });
  assert.deepEqual(device.roles.fanSpeed.control.options.map((option) => option.label), ["Auto", "High", "Med", "Low"]);
  assert.equal(device.roles.fanSpeed.id, alias.id);
  assert.equal(device.roles.fanSpeed.value, 0);
  assert.equal(device.roles.fanSpeed.controlAvailable, true);
  const [forced] = buildDevices([source, { ...alias, state: 2 }], { metadataById: descriptions });
  assert.equal(forced.roles.fanSpeed.controlAvailable, false);
  const [readonly] = buildDevices([source, alias], {
    metadataById: { ...descriptions, [alias.id]: { ...descriptions[alias.id], writeable: 0 } },
  });
  assert.equal(readonly.roles.fanSpeed.controlAvailable, false);
  const [failed] = buildDevices([source, { ...alias, error: "Read failed" }], { metadataById: descriptions });
  assert.equal(failed.roles.fanSpeed.controlAvailable, false);
  const [widgetDescription] = buildDevices([
    { ...source, description: descriptions[source.id].description }, { ...alias, description: "Value" },
  ]);
  assert.equal(widgetDescription.roles.fanSpeed.control.options.length, 4);
  const [sourceOptions] = buildDevices([source, alias], {
    metadataById: {
      [source.id]: { writeable: 1, enumValues: [{ value: 0, label: "Auto" }, { value: 1, label: "High" }] },
      [alias.id]: { writeable: 1, description: "Value", enumValues: [] },
    },
  });
  assert.equal(sourceOptions.roles.fanSpeed.control.options[1].label, "High");
});

test("groups the observed 55 functions, 34 Value references and 63 auxiliary properties into ten owners", () => {
  // The Oct 9 controller shape is kept compact here, independent of ignored
  // raw responses or credentials. IDs preserve real folders and source types.
  const widgets = [];
  const add = (owner, names, folder = "Values") => {
    const added = names.map((name) => ({ ...point(owner, name), id: `01/${owner}/${folder}/${name}` }));
    widgets.push(...added);
    return added;
  };
  const alias = (values) => widgets.push(...values.map((value) => ({ ...value, id: `11/${value.id.slice(3)}/Value` })));
  const auxiliary = (path, names) => widgets.push(...names.map((name) => ({ id: `11/${path}/${name}`, value: 0, state: 0, writable: true })));
  const logged = (owner, names) => names.forEach((name) => auxiliary(`${owner}/Logs/Trend Logs/${name}`, ["TotalRecordCount"]));
  const trio = (values) => values.forEach((value) => auxiliary(value.id.slice(3), ["OutOfService", "Reliability"]));
  add("03AS001/Zones/Z312", ["OccSts", "LtVal", "LtLvl"]);
  add(blind, ["BlndBtnUp", "BlndBtnDn"], "Points");
  add(blind, ["BlndAng", "BlndVal", "BlndSts", "BlndPos", "BlndSlt"]);
  const group = `${zone}/G3308`;
  const groupPoints = [...add(group, ["GrpPct"], "Points"), ...add(group, ["OccSts"])];
  alias(groupPoints); trio(groupPoints);
  groupPoints.forEach((value) => auxiliary(value.id.slice(3), ["ActiveCommandPriority"]));
  logged(group, ["GrpPct", "OccSts"]);
  for (const name of ["L3307", "L3309", "L3322", "L3325"]) {
    const owner = `${zone}/${name}`;
    const points = add(owner, ["LtPct", "EcgFlt", "LtFlt", "LtCol", "LtVal", "DevSta"]);
    alias(points.filter((value) => !value.id.endsWith("/DevSta")));
    auxiliary(`${owner}/Values/LtPct`, ["ActiveCommandPriority"]);
    auxiliary(`${owner}/Values/LtVal`, ["OutOfService", "Reliability"]);
    logged(owner, ["LtVal"]);
    auxiliary(`${owner}/Alarms/DevSta`, ["EventState"]);
  }
  const sensor = `${rp("RP31")}/Application/Zones/Z312/S3201`;
  const sensorPoints = add(sensor, ["DevSta", "LtLvl", "OccSts", "DevErr", "DevCol"]);
  alias(sensorPoints.filter((value) => /\/(LtLvl|DevErr|DevCol)$/.test(value.id)));
  auxiliary(`${sensor}/Values/LtLvl`, ["ActiveCommandPriority", "OutOfService", "Reliability"]);
  logged(sensor, ["LtLvl"]);
  auxiliary(`${sensor}/Alarms/DevSta`, ["EventState"]);
  add(`${zone}/S3201`, ["OccSts", "LtLvl"], "External Bindings");
  add(ac, ["ScrnCol"]);
  add(ac, ["IduSts", "RmCO2"], "Points/Input Registers");
  const acPoints = [
    ...add(ac, ["FilAlm"], "Points/Coils"),
    ...add(ac, ["IduAlm", "RmRh", "RmTmp"], "Points/Input Registers"),
    ...add(ac, ["EffSpt", "FanSpd", "OnOffMd", "SysMdSts", "SysMdCtrl"], "Points/Holding Registers"),
  ];
  alias(acPoints);
  trio(acPoints.filter((value) => !value.id.endsWith("/SysMdCtrl")));
  acPoints.filter((value) => /\/(EffSpt|FanSpd|OnOffMd|SysMdSts)$/.test(value.id)).forEach((value) => auxiliary(value.id.slice(3), ["ActiveCommandPriority"]));
  logged(ac, ["EffSpt", "FanSpd", "OnOffMd", "RmRh", "RmTmp", "SysMdSts"]);
  auxiliary(ac, ["DeviceProductCode", "DeviceProductRevision", "DeviceVendorName", "Status"]);

  assert.equal(widgets.filter((value) => value.id.startsWith("01/")).length, 55);
  assert.equal(widgets.length, 152);
  const devices = buildDevices(widgets);
  assert.equal(devices.length, 10);
  assert.equal(devices.reduce((sum, device) => sum + device.pointsCount, 0), 152);
  assert.equal(devices.reduce((sum, device) => sum + device.aliases.length, 0), 34);
  assert.equal(devices.reduce((sum, device) => sum + device.support.length, 0), 63);
  assert.equal(devices.reduce((sum, device) => sum + device.primary.length + device.diagnostics.length + device.other.length - device.support.length, 0), 55);
  assert.equal(devices.filter((device) => device.type === "light").length, 4);
  assert.equal(devices.filter((device) => device.type === "sensor").length, 2);
  assert.equal(devices.filter((device) => device.type === "zone").length, 1);
  assert.ok(devices.flatMap((device) => device.support).every((value) => !value.writeAllowed));
});

test("browser and server use the same pure model and do not mutate snapshots", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../public/widgetGrouping"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../public/deviceModel"), "utf8"), context);
  const values = [point(light, "LtPct"), point(light, "LtVal")];
  const original = JSON.stringify(values);
  assert.deepEqual(JSON.parse(JSON.stringify(context.IoTDeviceModel.buildDevices(values))), buildDevices(values));
  assert.equal(JSON.stringify(values), original);
});

test("real controls require explicit server permission and reject aliases and ambiguous roles", () => {
  const source = point(light, "LtPct");
  assert.equal(normalizePoint(source).liveControlAvailable, false);
  assert.equal(normalizePoint(source, { writeable: 1 }).liveControlAvailable, true);
  const alias = { ...source, id: `11/${light}/Values/LtPct/Value` };
  assert.equal(normalizePoint(alias, { writeable: 1 }).liveControlAvailable, false);
  const duplicate = { ...source, id: `01/${light}/Points/GrpPct` };
  const [device] = buildDevices([source, duplicate], {
    metadataById: { ...metadata(source.id), ...metadata(duplicate.id) },
  });
  assert.equal(device.roles.brightnessSet.roleAmbiguous, true);
  assert.equal(validateDeviceCommand(device.roles.brightnessSet, 20).allowed, false);
});

test("blind and slat commands accept normalized bounds and fractions unchanged while preserving write protections", () => {
  for (const name of ["BlndPos", "BlndSlt"]) {
    const source = point(blind, name, { value: 0.36 });
    const position = normalizePoint(source, { writeable: 1, unit: "" });
    assert.equal(position.liveControlAvailable, true);
    assert.deepEqual(position.control, { kind: "range", min: 0, max: 1, step: 0.01, rangeConfirmed: true, rangeSource: "user-confirmed" });
    for (const value of [0, 0.36, 1]) {
      assert.deepEqual(validateDeviceCommand(position, value), { allowed: true, value });
    }
    for (const value of [-0.01, 1.01, 36, "0.36", null, true, NaN, Infinity]) {
      assert.equal(validateDeviceCommand(position, value).allowed, false);
    }
    for (const blocked of [
      normalizePoint({ ...source, state: 2 }, { writeable: 1 }),
      normalizePoint(source, { writeable: 0 }),
      normalizePoint({ ...source, writable: false }, { writeable: 1 }),
      normalizePoint({ ...source, id: `11/${blind}/Values/${name}/Value` }, { writeable: 1 }),
    ]) {
      assert.equal(validateDeviceCommand(blocked, 0.36).allowed, false);
    }
  }
});

test("real command validation enforces numeric bounds and controller enum options without coercing arbitrary values", () => {
  const brightness = normalizePoint(point(light, "LtPct"), { writeable: 1 });
  for (const value of [-1, 101, NaN, Infinity, "50", null, {}, true]) {
    assert.equal(validateDeviceCommand(brightness, value).allowed, false);
  }
  assert.deepEqual(validateDeviceCommand(brightness, 50), { allowed: true, value: 50 });
  const mode = normalizePoint(point(ac, "SysMdCtrl", { value: 1 }), {
    writeable: 1, enumValues: [{ value: 0, label: "Heat" }, { value: 1, label: "Cool" }],
  });
  assert.deepEqual(validateDeviceCommand(mode, "0"), { allowed: true, value: 0 });
  assert.equal(validateDeviceCommand(mode, 2).allowed, false);
  assert.equal(validateDeviceCommand({ ...mode, state: 2, liveControlAvailable: false }, 0).allowed, false);
  for (const [unit, min, max] of [["°C", 5, 35], ["°F", 41, 95], ["K", 278.15, 308.15]]) {
    const target = normalizePoint(point(ac, "EffSpt", { value: (min + max) / 2 }), { writeable: 1, unit });
    assert.equal(target.control.rangeSource, "dashboard-policy");
    assert.equal(validateDeviceCommand(target, min).allowed, true);
    assert.equal(validateDeviceCommand(target, max).allowed, true);
    assert.equal(validateDeviceCommand(target, min - 0.5).allowed, false);
    assert.equal(validateDeviceCommand(target, max + 0.5).allowed, false);
  }
});
