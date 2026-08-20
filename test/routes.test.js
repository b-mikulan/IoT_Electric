const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../middleware/app");
const swaggerDocument = require("../middleware/swaggerDocument");

function createFakeEws() {
  return {
    async getWebServiceInformation() {
      return { version: "test-version" };
    },
    async getValues(ids) {
      return { ids };
    },
    async subscribe(options) {
      return {
        subscriptionId: "test-subscription",
        options,
      };
    },
  };
}

async function startTestApp(t) {
  const allowAll = (req, res, next) => next();
  const app = createApp({
    ews: createFakeEws(),
    middlewareAuth: allowAll,
    swaggerDocument,
  });

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => {
      resolve(listeningServer);
    });
  });

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );

  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("serves the existing API routes after modularization", async (t) => {
  const baseUrl = await startTestApp(t);

  const infoResponse = await fetch(`${baseUrl}/api/info`);
  assert.equal(infoResponse.status, 200);
  assert.deepEqual(await infoResponse.json(), { version: "test-version" });

  const valuesResponse = await fetch(`${baseUrl}/api/values/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["point-1", "point-2"] }),
  });
  assert.equal(valuesResponse.status, 200);
  assert.deepEqual(await valuesResponse.json(), {
    ids: ["point-1", "point-2"],
  });
});

test("preserves validation and subscription creation status", async (t) => {
  const baseUrl = await startTestApp(t);

  const invalidValuesResponse = await fetch(`${baseUrl}/api/values/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(invalidValuesResponse.status, 400);

  const subscriptionResponse = await fetch(`${baseUrl}/api/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["point-1"] }),
  });
  assert.equal(subscriptionResponse.status, 201);

  const subscriptionBody = await subscriptionResponse.json();
  assert.equal(subscriptionBody.subscriptionId, "test-subscription");
  assert.deepEqual(subscriptionBody.options, {
    ids: ["point-1"],
    eventType: 0,
    eventMode: 0,
    expires: "PT30M",
    notifyToAddress: "",
    metadata: false,
  });
});

test("keeps health public in the OpenAPI document", () => {
  assert.deepEqual(swaggerDocument.paths["/health"].get.security, []);
  assert.ok(swaggerDocument.paths["/api/info"]);
  assert.ok(swaggerDocument.paths["/api/values/read"]);
  assert.ok(swaggerDocument.paths["/api/subscriptions"]);
});
