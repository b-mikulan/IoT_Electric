const express = require("express");
const path = require("node:path");

const publicDirectory = path.join(__dirname, "../../public");
const materializeDirectory = path.dirname(
  require.resolve("@materializecss/materialize/dist/css/materialize.min.css")
);

// Keep browser URLs independent of the source folders.
const assetsByFolder = {
  admin: ["admin.css", "adminApi.js", "adminUsers.js", "adminSystem.js"],
  dashboard: ["app.js", "dashboard.css"],
  devices: ["deviceCards.css", "deviceCards.js", "deviceModel.js", "widgetGrouping.js"],
  shared: ["dashboardSettings.css", "dashboardSettings.js", "dashboardTheme.css", "favicon.svg", "styles.css"],
  transfer: ["transfer.css", "transfer.js"],
  trends: ["trends.css", "trends.js"],
};
const vendorFiles = {
  "/vendor/datatables.js": require.resolve("datatables.net/js/dataTables.min.js"),
  "/vendor/datatables.css": require.resolve("datatables.net-dt/css/dataTables.dataTables.min.css"),
  "/vendor/chart.js": path.join(path.dirname(require.resolve("chart.js")), "chart.umd.min.js"),
};

function createStaticAssets() {
  const router = express.Router({ strict: true });
  router.use("/vendor/materialize", express.static(materializeDirectory, {
    immutable: true,
    maxAge: "7d",
  }));
  for (const [url, file] of Object.entries(vendorFiles)) {
    router.get(url, (request, response) => response.sendFile(file));
  }
  for (const [folder, names] of Object.entries(assetsByFolder)) {
    for (const name of names) {
      const file = path.join(publicDirectory, folder, name);
      router.get(`/${name}`, (request, response) => response.sendFile(file));
    }
  }
  router.use(express.static(path.join(publicDirectory, "pages")));
  return router;
}

module.exports = { createStaticAssets };
