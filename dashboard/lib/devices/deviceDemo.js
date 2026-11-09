// Synthetic examples for the device-card playground; no controller IDs or requests.
function createDeviceDemo() {
  const kitchen = "Demo/Application/Zones/Kitchen";
  const other = "Demo/IO Resources/Modbus";
  const widgets = [];
  const metadataById = {};
  function point(owner, name, description, unit, value, writeable = false) {
    const id = `01/${owner}/Values/${name}`;
    widgets.push({ id, label: name, description, unit, value, state: 0, error: null, visible: true, writable: false });
    metadataById[id] = { id, name, description, unit, type: "Double", writeable, forceable: false, enumId: null, enumValues: [] };
    return id;
  }
  point(`${kitchen}/Lampa`, "LtPct", "Light percent set", "%", 65, true);
  point(`${kitchen}/Lampa`, "LtVal", "Light percent status", "%", 65);
  point(`${other}/Klima`, "RmTmp", "Room temperature", "°C", 22.4);
  point(`${other}/Klima`, "RmRh", "Relative humidity", "%", 46);
  point(`${other}/Klima`, "EffSpt", "Effective setpoint", "°C", 23, true);
  const mode = point(`${other}/Klima`, "SysMdCtrl", "System mode control: 0=Heat, 1=Cool, 2=Fan, 3=Dry, 4=Auto", "", 4, true);
  metadataById[mode].enumValues = [{ value: 0, label: "Heat" }, { value: 1, label: "Cool" }, { value: 2, label: "Fan" }, { value: 3, label: "Dry" }, { value: 4, label: "Auto" }];
  point(`${other}/Klima`, "SysMdSts", "System mode status: 0=Heat, 1=Cool, 2=Fan, 3=Dry, 4=Auto(Heat), 5=Auto(Cool)", "", 1);
  const fan = point(`${other}/Klima`, "FanSpd", "Fan speed: 0=Auto, 1=High, 2=Med, 3=Low", "", 0, true);
  metadataById[fan].enumValues = [{ value: 0, label: "Auto" }, { value: 1, label: "High" }, { value: 2, label: "Med" }, { value: 3, label: "Low" }];
  point(`${other}/Klima`, "OnOffMd", "On/Off mode: 0=Off, 1=On", "", 1, true);
  point(`${other}/Roleta`, "BlndPos", "Blind height position set", "%", 36, true);
  point(`${other}/Roleta`, "BlndVal", "Blind height position status", "%", 36);
  point(`${kitchen}/Senzor`, "LtLvl", "Illuminance", "lx", 222);
  point(`${kitchen}/Senzor`, "OccSts", "Occupancy status", "", 0);
  return { widgets, metadataById, roomByZone: { [kitchen]: "Kuhinja · demo" } };
}

module.exports = { createDeviceDemo };
