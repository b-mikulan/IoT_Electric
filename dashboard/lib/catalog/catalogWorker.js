const { parentPort, workerData } = require("node:worker_threads");

const MAX_IMPORT_POINTS = 50_000;

function importPoints(catalog, { snapshotId, deviceKeys }) {
  const { id } = catalog.snapshot({ snapshotId });
  const keys = JSON.stringify(deviceKeys);
  const unknownDevice = catalog.db.prepare(`
    SELECT 1 FROM json_each(?) AS selected
    WHERE NOT EXISTS (SELECT 1 FROM devices WHERE snapshot_id = ? AND key = selected.value)
    LIMIT 1
  `).get(keys, id);
  if (unknownDevice) return { unknownDevice: true };

  const points = catalog.db.prepare(`
    SELECT DISTINCT p.id, o.name, o.description, p.unit
    FROM json_each(?) AS selected
    JOIN device_points dp ON dp.snapshot_id = ? AND dp.device_key = selected.value
    JOIN points p ON p.snapshot_id = dp.snapshot_id AND p.id = dp.point_id
    JOIN objects o ON o.snapshot_id = p.snapshot_id AND o.kind = p.kind AND o.id = p.id
    WHERE p.native = 1 AND substr(p.id, 1, 3) = '01/'
    ORDER BY p.id LIMIT ?
  `).all(keys, id, MAX_IMPORT_POINTS + 1);
  return points.length > MAX_IMPORT_POINTS ? { tooMany: true } : { points };
}

try {
  if (workerData.operation === "import") {
    const { importTopology } = require("../../../catalog/importTopology");
    const result = importTopology({ checkpoint: workerData.checkpoint, database: workerData.database, building: "default", label: "Admin scan" });
    parentPort.postMessage({ snapshotId: result.snapshotId, devices: Object.values(result.summary.deviceGroups).reduce((sum, count) => sum + count, 0), points: result.summary.points.total });
  } else {
    const { BuildingCatalog } = require("../../../catalog/store");
    const catalog = new BuildingCatalog(workerData.database);
    try {
      const result = workerData.operation === "importPoints"
        ? importPoints(catalog, workerData)
        : catalog.listDevices({ snapshotId: workerData.snapshotId, search: workerData.search, offset: workerData.offset, limit: 50 });
      parentPort.postMessage(result);
    }
    finally { catalog.close(); }
  }
} catch {
  parentPort.postMessage({ error: "Katalog nije moguće obraditi. Spremljeni checkpoint ostaje dostupan." });
}
