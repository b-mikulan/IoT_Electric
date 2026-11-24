const express = require("express");
const swaggerUi = require("swagger-ui-express");
const { createMiddlewareAuth } = require("./middlewareAuth");
const { errorHandler } = require("./errorHandler");
const { createApiRouter } = require("./routes");
const { requestSignal } = require("./ewsClient");
const defaultSwaggerDocument = require("./swaggerDocument");

function createApp({
  ews,
  middlewareAuth = createMiddlewareAuth(),
  swaggerDocument = defaultSwaggerDocument,
  version = process.env.APP_VERSION?.trim(),
} = {}) {
  if (!ews) {
    throw new Error("An EWS client is required to create the application.");
  }

  const app = express();
  // Behind a reverse proxy, set TRUST_PROXY (hop count such as 1, or an address
  // list) so login throttling sees the real client address, not the proxy's.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  app.use(express.json());
  // When the REST client gives up, stop the controller call made on its behalf.
  // Registered after the body parser, which would drop the async context.
  app.use((req, res, next) => {
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    requestSignal.run(controller.signal, next);
  });

  app.get("/health", (req, res) => {
    // APP_VERSION is set at image build time from the release tag.
    res.json({ status: "ok", ...(version && { version }) });
  });

  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerDocument)
  );

  app.use("/api", middlewareAuth, createApiRouter(ews));

  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp,
};
