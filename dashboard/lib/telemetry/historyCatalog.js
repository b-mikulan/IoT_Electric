const { buildDevices } = require("../../public/devices/deviceModel");
const { deriveWidgetGrouping } = require("../../public/devices/widgetGrouping");

function normalizeHistoryItems(items) {
  if (!Array.isArray(items) || items.length > 50_000) throw new Error("Neispravan popis trendova.");
  const ids = new Set();
  const text = (value, max, fallback = "") => {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "string" || result.length > max || /[\0\r\n]/.test(result)) throw new Error("Neispravan opis trenda.");
    return result;
  };
  return items.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Neispravan trend.");
    const id = text(item.id, 4096);
    if (!id || ids.has(id)) throw new Error("Nedostaje ili je ponovljen ID trenda.");
    ids.add(id);
    if (item.parentIds !== undefined && (!Array.isArray(item.parentIds) || item.parentIds.length > 1000)) throw new Error("Neispravne mape trenda.");
    return { id, name: text(item.name, 500, id), description: text(item.description, 4000), unit: text(item.unit, 40),
      valueItemId: text(item.valueItemId, 4096), parentIds: [...new Set((item.parentIds || []).map(value => text(value, 4096)))] };
  });
}

function buildHistoryCatalog(saved, widgets, options) {
  const devices = new Map(buildDevices(widgets, options).map(device => [device.key, device]));
  const items = saved.items.map(item => {
    // Only the EWS definition's explicit ValueItemId can associate a device.
    // Similar short names and neighbouring folders do not establish a binding.
    const device = item.valueItemId ? devices.get(deriveWidgetGrouping(item.valueItemId).key) : null;
    return { ...item, device: device ? { key: device.key, label: device.label, room: device.room } : null };
  });
  return { available: saved.available, capturedAt: saved.capturedAt || null, total: items.length, linkedDevices: items.filter(item => item.device).length, items };
}

module.exports = { normalizeHistoryItems, buildHistoryCatalog };
