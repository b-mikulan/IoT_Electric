const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { composePage } = require("./pageTemplates");

const publicDirectory = path.join(__dirname, "../../public");
const pagesDirectory = path.join(publicDirectory, "pages");
const partialsDirectory = path.join(publicDirectory, "partials");
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
// These pages include shared markup from public/partials (see pageTemplates.js).
// They are composed on every request, so an HTML edit still shows on reload.
const composedPages = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/technical.html", "technical.html"]]);

function readPartial(name) {
  const file = path.join(partialsDirectory, `${name}.html`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

// Resolves the URL the way express.static would, so an encoded or
// doubled-slash spelling of a composed page cannot fall through to it and be
// sent uncomposed.
function composedPageFor(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  try {
    const pathname = decodeURIComponent(request.path).replaceAll("\\", "/");
    return composedPages.get(path.posix.normalize(pathname).toLowerCase());
  } catch {
    return undefined; // Malformed escape: express.static answers it.
  }
}

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
  router.use((request, response, next) => {
    const name = composedPageFor(request);
    if (!name) return next();
    const page = composePage(fs.readFileSync(path.join(pagesDirectory, name), "utf8"), readPartial);
    return response.set("Cache-Control", "public, max-age=0").type("html").send(page);
  });
  router.use(express.static(pagesDirectory));
  return router;
}

module.exports = { createStaticAssets };
