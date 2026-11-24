const dotenv = require("dotenv");

dotenv.config();

const { createApp } = require("./app");
const { createEwsClient } = require("./ewsClient");
const { createMiddlewareAuth } = require("./middlewareAuth");
const { resolveMiddlewareCredentials } = require("./generatedCredentials");
const { installExtraCertificates } = require("./caCertificates");
const swaggerDocument = require("./swaggerDocument");

const port = process.env.PORT || 3000;
// Before any controller connection, so EWS_CA_CERT / EWS_CA_FILE apply to all.
const extraCertificates = installExtraCertificates(process.env);
const ews = createEwsClient();
// Resolved before listening, so the password file exists by the time the
// healthcheck lets the dashboard start.
const credentials = resolveMiddlewareCredentials(process.env);
const middlewareAuth = createMiddlewareAuth(credentials);
const app = createApp({ ews, swaggerDocument, middlewareAuth });

if (require.main === module) {
  app.listen(port, () => {
    console.log(`REST wrapper running on http://localhost:${port}`);
    console.log(`Swagger UI available at http://localhost:${port}/api-docs`);
    if (extraCertificates) console.log(`Trusting ${extraCertificates} additional EWS certificate(s).`);
    if (credentials.generated) {
      console.log(`Using the generated middleware password in ${process.env.MIDDLEWARE_GENERATED_PASSWORD_FILE}`);
    }
  });
}

module.exports = {
  app,
  createApp,
  swaggerDocument,
};
