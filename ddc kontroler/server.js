const dotenv = require("dotenv");

dotenv.config();

const { createApp } = require("./app");
const { createEwsClient } = require("./ewsClient");
const swaggerDocument = require("./swaggerDocument");

const port = process.env.PORT || 3000;
const ews = createEwsClient();
const app = createApp({ ews, swaggerDocument });

if (require.main === module) {
  app.listen(port, () => {
    console.log(`REST wrapper running on http://localhost:${port}`);
    console.log(`Swagger UI available at http://localhost:${port}/api-docs`);
  });
}

module.exports = {
  app,
  createApp,
  swaggerDocument,
};
