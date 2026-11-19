const { parentPort, workerData } = require("node:worker_threads");
try {
  if (workerData.operation === "import") {
    const { importTopology } = require("../../../catalog/importTopology");
    const result = importTopology({ checkpoint: workerData.checkpoint, database: workerData.database, building: "default", label: "Admin scan" });
    parentPort.postMessage({ snapshotId: result.snapshotId, devices: Object.values(result.summary.deviceGroups).reduce((sum, count) => sum + count, 0), points: result.summary.points.total });
  } else {
    const { BuildingCatalog } = require("../../../catalog/store");
    const catalog = new BuildingCatalog(workerData.database);
    try { parentPort.postMessage(catalog.listDevices({ search: workerData.search, offset: workerData.offset, limit: 50 })); }
    finally { catalog.close(); }
  }
} catch {
  parentPort.postMessage({ error: "Katalog nije moguće obraditi. Spremljeni checkpoint ostaje dostupan." });
}
