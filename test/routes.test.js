const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../middleware/app");
const swaggerDocument = require("../middleware/swaggerDocument");

function createFakeEws(overrides = {}) {
  return {
    async getWebServiceInformation() {
      return { version: "test-version" };
    },
    async getValues(ids) {
      return { ids };
    },
    async setValues(items) {
      return {
        results: items.map(({ id }) => ({
          id,
          success: true,
          message: "",
        })),
      };
    },
    async subscribe(options) {
      return {
        subscriptionId: "test-subscription",
        options,
      };
    },
    ...overrides,
  };
}

async function startTestApp(t, ews = createFakeEws()) {
  const allowAll = (req, res, next) => next();
  const app = createApp({
    ews,
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

async function postJson(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

test("writes scalar datapoint values through the EWS client", async (t) => {
  const writes = [];
  const ews = createFakeEws({
    async setValues(items) {
      writes.push(items);
      return {
        results: items.map(({ id }) => ({
          id,
          success: id !== "digital",
          message: id === "digital" ? "Point is not writable" : "",
        })),
      };
    },
  });
  const baseUrl = await startTestApp(t, ews);
  const items = [
    { id: "analog", value: 0 },
    { id: "digital", value: false },
    { id: "string", value: "" },
    { id: "temperature", value: 21.5 },
  ];

  const response = await postJson(baseUrl, "/api/values/write", { items });

  assert.equal(response.status, 200);
  assert.deepEqual(writes, [items]);
  assert.deepEqual(await response.json(), {
    results: items.map(({ id }) => ({
      id,
      success: id !== "digital",
      message: id === "digital" ? "Point is not writable" : "",
    })),
  });

  const maximumBatch = Array.from({ length: 100 }, (_, index) => ({
    id: `point-${index}`,
    value: index,
  }));
  const maximumResponse = await postJson(
    baseUrl,
    "/api/values/write",
    { items: maximumBatch }
  );
  assert.equal(maximumResponse.status, 200);
  assert.equal((await maximumResponse.json()).results.length, 100);
  assert.deepEqual(writes, [items, maximumBatch]);
});

test("rejects malformed datapoint writes before calling EWS", async (t) => {
  let writeCalls = 0;
  const ews = createFakeEws({
    async setValues() {
      writeCalls += 1;
      return { results: [] };
    },
  });
  const baseUrl = await startTestApp(t, ews);
  const invalidBodies = [
    {},
    { items: null },
    { items: {} },
    { items: [] },
    { items: [null] },
    { items: [[]] },
    { items: ["not-an-item"] },
    { items: [{ value: 1 }] },
    { items: [{ id: 123, value: 1 }] },
    { items: [{ id: "   ", value: 1 }] },
    { items: [{ id: "point-1" }] },
    { items: [{ id: "point-1", value: null }] },
    { items: [{ id: "point-1", value: {} }] },
    { items: [{ id: "point-1", value: [] }] },
    {
      items: Array.from({ length: 101 }, (_, index) => ({
        id: `point-${index}`,
        value: index,
      })),
    },
  ];

  for (const body of invalidBodies) {
    const response = await postJson(baseUrl, "/api/values/write", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, "string");
  }

  assert.equal(writeCalls, 0);
});

test("returns EWS write failures without masking SOAP details", async (t) => {
  const ews = createFakeEws({
    async setValues() {
      const error = new Error("Controller rejected the write request");
      error.status = 502;
      error.soapFault = {
        code: "Sender",
        reason: "Invalid write request",
      };
      throw error;
    },
  });
  const baseUrl = await startTestApp(t, ews);
  const originalConsoleError = console.error;
  console.error = () => {};

  let response;
  try {
    response = await postJson(baseUrl, "/api/values/write", {
      items: [{ id: "point-1", value: 1 }],
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Controller rejected the write request",
    soapFault: {
      code: "Sender",
      reason: "Invalid write request",
    },
  });
});

test("keeps health public in the OpenAPI document", () => {
  assert.deepEqual(swaggerDocument.paths["/health"].get.security, []);
  assert.ok(swaggerDocument.paths["/api/info"]);
  assert.ok(swaggerDocument.paths["/api/values/read"]);
  assert.ok(swaggerDocument.paths["/api/values/write"]);
  assert.ok(swaggerDocument.paths["/api/subscriptions"]);

  const writeOperation = swaggerDocument.paths["/api/values/write"].post;
  const writeSchema =
    writeOperation.requestBody.content["application/json"].schema;
  assert.deepEqual(writeSchema.required, ["items"]);
  assert.deepEqual(writeSchema.properties.items.items.required, ["id", "value"]);
  assert.equal(writeSchema.properties.items.maxItems, 100);
  assert.equal(writeSchema.properties.items.items.properties.id.pattern, "\\S");
  assert.deepEqual(
    writeSchema.properties.items.items.properties.value.oneOf.map(
      ({ type }) => type
    ),
    ["string", "number", "boolean"]
  );
  assert.ok(writeOperation.responses[200]);
  assert.ok(writeOperation.responses[400]);
  assert.ok(writeOperation.responses[500]);
});
