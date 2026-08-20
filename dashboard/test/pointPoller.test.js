const test = require("node:test");
const assert = require("node:assert/strict");
const { PointPoller } = require("../lib/pointPoller");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("posts widget ids with Basic auth and exposes values without credentials", async () => {
  const requests = [];
  const updates = [];
  const statuses = [];
  const poller = new PointPoller({
    middlewareUrl: "https://middleware.example.test///",
    username: "dashboard",
    password: "secret value",
    widgets: [
      { id: "building/temperature", label: "Office", unit: "°C" },
      { id: "building/power", label: "Power", unit: "kW" },
    ],
    now: () => new Date("2026-08-20T08:15:00.000Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        values: [
          { id: "building/temperature", value: 22.4, state: "ok" },
          { id: "building/power", value: 3.17, state: "ok" },
        ],
        errors: [],
      });
    },
  });

  poller.on("update", (event) => updates.push(event));
  poller.on("status", (event) => statuses.push(event));

  const snapshot = await poller.poll();

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://middleware.example.test/api/values/read"
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(
    requests[0].options.headers.Authorization,
    `Basic ${Buffer.from("dashboard:secret value").toString("base64")}`
  );
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    ids: ["building/temperature", "building/power"],
  });

  assert.deepEqual(statuses, [
    {
      status: "connected",
      syncedAt: "2026-08-20T08:15:00.000Z",
      error: null,
    },
  ]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].widgets[0].label, "Office");
  assert.equal(updates[0].widgets[0].value, 22.4);
  assert.equal(
    updates[0].widgets[0].updatedAt,
    "2026-08-20T08:15:00.000Z"
  );
  assert.equal(snapshot.status, "connected");
  assert.equal(snapshot.widgets[1].value, 3.17);
  assert.equal(Object.hasOwn(snapshot, "username"), false);
  assert.equal(Object.hasOwn(snapshot, "password"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret value"), false);
});

test("does not emit an update when a second poll has unchanged point data", async () => {
  const updates = [];
  const syncs = [];
  const times = [
    new Date("2026-08-20T08:00:00.000Z"),
    new Date("2026-08-20T08:00:15.000Z"),
  ];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "user",
    password: "password",
    widgets: [{ id: "point-1", label: "Point" }],
    now: () => times.shift(),
    fetchImpl: async () =>
      jsonResponse({
        values: [{ id: "point-1", value: 42, state: "ok" }],
        errors: [],
      }),
  });

  poller.on("update", (event) => updates.push(event));
  poller.on("sync", (event) => syncs.push(event));

  await poller.poll();
  await poller.poll();

  assert.equal(updates.length, 1);
  assert.equal(syncs.length, 2);
  assert.equal(poller.getSnapshot().syncedAt, "2026-08-20T08:00:15.000Z");
  assert.equal(
    poller.getSnapshot().widgets[0].updatedAt,
    "2026-08-20T08:00:00.000Z"
  );
});

test("emits only the point that changed after the initial snapshot", async () => {
  const updates = [];
  let pollNumber = 0;
  const times = [
    new Date("2026-08-20T08:00:00.000Z"),
    new Date("2026-08-20T08:00:15.000Z"),
  ];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "user",
    password: "password",
    widgets: [{ id: "temperature" }, { id: "humidity" }],
    now: () => times.shift(),
    fetchImpl: async () => {
      pollNumber += 1;
      return jsonResponse({
        values: [
          { id: "temperature", value: pollNumber === 1 ? 21 : 22, state: 0 },
          { id: "humidity", value: 50, state: 0 },
        ],
        errors: [],
      });
    },
  });

  poller.on("update", (event) => updates.push(event));

  await poller.poll();
  const secondSnapshot = await poller.poll();

  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates[1].widgets.map(({ id }) => id),
    ["temperature"]
  );
  assert.equal(
    secondSnapshot.widgets.find(({ id }) => id === "temperature").updatedAt,
    "2026-08-20T08:00:15.000Z"
  );
  assert.equal(
    secondSnapshot.widgets.find(({ id }) => id === "humidity").updatedAt,
    "2026-08-20T08:00:00.000Z"
  );
});

test("maps point errors and reports changing connection errors and recovery", async () => {
  const statuses = [];
  const updates = [];
  let attempt = 0;
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "user",
    password: "password",
    widgets: [{ id: "point-1", label: "Point" }],
    now: () => new Date("2026-08-20T09:00:00.000Z"),
    fetchImpl: async () => {
      attempt += 1;

      if (attempt <= 2) {
        throw new Error(`offline-${attempt}`);
      }

      return jsonResponse({
        values: [],
        errors: [{ id: "point-1", message: "Point is unavailable" }],
      });
    },
  });

  poller.on("status", (event) => statuses.push(event));
  poller.on("update", (event) => updates.push(event));

  const first = await poller.poll();
  const second = await poller.poll();
  const recovered = await poller.poll();

  assert.equal(first.status, "error");
  assert.equal(first.error, "offline-1");
  assert.equal(second.status, "error");
  assert.equal(second.error, "offline-2");
  assert.deepEqual(
    statuses.map(({ status }) => status),
    ["error", "error", "connected"]
  );
  assert.equal(recovered.status, "connected");
  assert.equal(recovered.widgets[0].error, "Point is unavailable");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].widgets[0].error, "Point is unavailable");
});

test("shares one in-flight request between overlapping poll calls", async () => {
  let fetchCalls = 0;
  let releaseFetch;
  const pendingResponse = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "user",
    password: "password",
    widgets: [{ id: "point-1" }],
    fetchImpl: async () => {
      fetchCalls += 1;
      return pendingResponse;
    },
  });

  const firstPoll = poller.poll();
  const overlappingPoll = poller.poll();

  assert.equal(fetchCalls, 1);
  releaseFetch(
    jsonResponse({
      values: [{ id: "point-1", value: 1, state: "ok" }],
      errors: [],
    })
  );

  const [firstSnapshot, overlappingSnapshot] = await Promise.all([
    firstPoll,
    overlappingPoll,
  ]);

  assert.equal(fetchCalls, 1);
  assert.deepEqual(overlappingSnapshot, firstSnapshot);
});

test("aborts a middleware request that exceeds the configured timeout", async () => {
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "user",
    password: "password",
    widgets: [{ id: "point-1" }],
    timeoutMs: 10,
    fetchImpl: async (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const snapshot = await poller.poll();

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "Middleware request timed out after 10 ms");
});

test("demo mode creates values in plausible ranges without fetching", async () => {
  const samples = [0.5, 0.5, 0.5, 0.5, 0.5];
  let fetchCalls = 0;
  const poller = new PointPoller({
    demoMode: true,
    widgets: [
      { id: "temperature", unit: "°C" },
      { id: "humidity", unit: "%" },
      { id: "voltage", unit: "V" },
      { id: "power", unit: "kW" },
      { id: "other" },
    ],
    random: () => samples.shift(),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("demo mode must not fetch");
    },
  });

  const snapshot = await poller.poll();
  const values = Object.fromEntries(
    snapshot.widgets.map(({ id, value }) => [id, value])
  );

  assert.equal(fetchCalls, 0);
  assert.equal(values.temperature, 22.5);
  assert.equal(values.humidity, 50);
  assert.equal(values.voltage, 230);
  assert.equal(values.power, 6);
  assert.equal(values.other, 50);
});
