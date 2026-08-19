const express = require("express");
const swaggerUi = require("swagger-ui-express");
const { createMiddlewareAuth } = require("./middlewareAuth");
const { errorHandler } = require("./middleware/errorHandler");
const { createApiRouter } = require("./routes");
const defaultSwaggerDocument = require("./swaggerDocument");

function createApp({
  ews,
  middlewareAuth = createMiddlewareAuth(),
  swaggerDocument = defaultSwaggerDocument,
} = {}) {
  if (!ews) {
    throw new Error("An EWS client is required to create the application.");
  }

  const app = express();

  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
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
