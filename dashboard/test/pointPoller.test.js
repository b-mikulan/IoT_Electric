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

test("writes only explicitly writable scalar values through middleware", async () => {
  const requests = [];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "dashboard",
    password: "secret",
    widgets: [
      { id: "setpoint", writable: true },
      { id: "temperature", writable: false },
    ],
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/values/write")) {
        return jsonResponse({
          results: [{ id: "setpoint", success: true, message: "accepted" }],
        });
      }
      return jsonResponse({
        values: [
          { id: "setpoint", value: 20, state: "ok" },
          { id: "temperature", value: 21, state: "ok" },
        ],
        errors: [],
      });
    },
  });

  await poller.poll();
  const result = await poller.writeValue("setpoint", 21.5);

  assert.deepEqual(result, {
    id: "setpoint",
    success: true,
    message: "accepted",
  });
  assert.equal(requests[1].url, "http://middleware/api/values/write");
  assert.equal(
    requests[1].options.headers.Authorization,
    `Basic ${Buffer.from("dashboard:secret").toString("base64")}`
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    items: [{ id: "setpoint", value: 21.5 }],
  });

  await poller.writeValue("setpoint", "Hello World");
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    items: [{ id: "setpoint", value: "Hello World" }],
  });

  await poller.writeValue("setpoint", false);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    items: [{ id: "setpoint", value: false }],
  });

  await assert.rejects(poller.writeValue("temperature", 22), {
    name: "PointWriteError",
    status: 403,
    code: "POINT_NOT_WRITABLE",
  });
  await assert.rejects(poller.writeValue("setpoint", null), {
    name: "PointWriteError",
    status: 400,
    code: "INVALID_VALUE",
  });
});

test("does not write in demo mode", async () => {
  const poller = new PointPoller({
    demoMode: true,
    widgets: [{ id: "demo", writable: true }],
  });

  await assert.rejects(poller.writeValue("demo", 1), {
    name: "PointWriteError",
    status: 409,
    code: "DEMO_MODE",
  });
});

test("discovers child containers and values with middleware credentials", async () => {
  const requests = [];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "dashboard",
    password: "secret",
    widgets: [{ id: "building/existing" }],
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse({
        containers: [
          {
            id: "building",
            name: "Building",
            containerItems: [
              { id: "building/floor", name: "Floor", type: "Container" },
            ],
            valueItems: [
              {
                id: "building/existing",
                name: "Existing",
                type: "AnalogValue",
                unit: "°C",
                writeable: 1,
              },
              {
                id: "building/power",
                name: "Power",
                type: "AnalogValue",
                unit: "kW",
                writeable: 0,
              },
            ],
          },
        ],
        errors: [],
      });
    },
  });

  const result = await poller.discoverObjects("building");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://middleware/api/containers?id=building");
  assert.equal(
    requests[0].options.headers.Authorization,
    `Basic ${Buffer.from("dashboard:secret").toString("base64")}`
  );
  assert.deepEqual(
    result.items.map(({ id, kind }) => [id, kind]),
    [
      ["building/floor", "container"],
      ["building/existing", "value"],
      ["building/power", "value"],
    ]
  );
  assert.equal(result.items[1].alreadyAdded, true);
  assert.equal(result.items[1].controllerWritable, true);
});

test("finds a pasted value id by looking in its parent container", async () => {
  const requests = [];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "dashboard",
    password: "secret",
    widgets: [{ id: "configured" }],
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      requests.push(requestUrl);
      if (requestUrl.endsWith("id=building%2Ftemperature")) {
        return jsonResponse({ error: "not a container" }, 500);
      }
      return jsonResponse({
        containers: [
          {
            id: "building",
            name: "Building",
            containerItems: [],
            valueItems: [
              {
                id: "building/temperature",
                name: "Temperature",
                unit: "°C",
                writeable: 0,
              },
            ],
          },
        ],
        errors: [],
      });
    },
  });

  const result = await poller.discoverObjects("building/temperature");

  assert.equal(requests.length, 2);
  assert.equal(result.exactMatch, true);
  assert.equal(result.containerId, "building");
  assert.deepEqual(result.items.map(({ id }) => id), ["building/temperature"]);
});

test("adds a discovered widget to the live poller as read-only", () => {
  const configEvents = [];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware",
    username: "dashboard",
    password: "secret",
    widgets: [{ id: "existing" }],
    fetchImpl: async () =>
      jsonResponse({
        values: [
          { id: "existing", value: 1 },
          { id: "new", value: 2 },
        ],
        errors: [],
      }),
  });
  poller.on("config", (event) => configEvents.push(event));

  const added = poller.addWidget({
    id: "new",
    label: "New",
    unit: "kW",
    writable: true,
  });

  assert.equal(added.writable, false);
  assert.equal(poller.getSnapshot().widgets.at(-1).id, "new");
  assert.equal(configEvents[0].widget.id, "new");
  assert.throws(() => poller.addWidget({ id: "new" }), {
    name: "PointDiscoveryError",
    code: "WIDGET_ALREADY_EXISTS",
  });
});

test("updates widget presentation settings without losing its current value", async () => {
  const configEvents = [];
  const poller = new PointPoller({
    demoMode: true,
    widgets: [
      {
        id: "temperature",
        label: "Temperature",
        unit: "°C",
        precision: 1,
      },
    ],
    random: () => 0.5,
  });
  poller.on("config", (event) => configEvents.push(event));
  await poller.poll();
  const previousValue = poller.getSnapshot().widgets[0].value;

  const updated = poller.updateWidget("temperature", {
    label: "Sobna temperatura",
    description: "Ured",
    unit: "°C",
    precision: 2,
    writable: true,
    visible: false,
  });
  const snapshot = poller.getSnapshot().widgets[0];

  assert.equal(updated.id, "temperature");
  assert.equal(updated.label, "Sobna temperatura");
  assert.equal(updated.writable, true);
  assert.equal(updated.visible, false);
  assert.equal(snapshot.value, previousValue);
  assert.equal(snapshot.precision, 2);
  assert.equal(configEvents[0].widget.label, "Sobna temperatura");
});

test("deletion survives an in-flight poll, stops reading deleted ids and disables their writes", async () => {
  let finishRequest;
  const requests = [];
  const removed = [];
  const poller = new PointPoller({
    middlewareUrl: "http://middleware", username: "client", password: "secret",
    widgets: [{ id: "delete", writable: true }, { id: "keep" }],
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).ids);
      if (requests.length === 1) return new Promise((resolve) => { finishRequest = resolve; });
      return jsonResponse({ values: [{ id: "keep", value: 2 }] });
    },
  });
  poller.on("removed", (event) => removed.push(event));
  const pending = poller.poll();
  poller.removeWidget("delete");
  finishRequest(jsonResponse({ values: [{ id: "delete", value: 1 }, { id: "keep", value: 2 }] }));
  await pending;
  assert.deepEqual(poller.getSnapshot().widgets.map((widget) => widget.id), ["keep"]);
  await assert.rejects(poller.writeValue("delete", 42), { code: "POINT_NOT_WRITABLE" });
  await poller.poll();
  assert.deepEqual(requests[1], ["keep"]);
  poller.removeWidget("keep");
  assert.deepEqual(removed, [{ id: "delete" }, { id: "keep" }]);
  await poller.poll();
  assert.equal(requests.length, 2);
  assert.deepEqual(poller.getSnapshot(), { status: "idle", syncedAt: null, error: null, widgets: [] });
  assert.throws(() => poller.removeWidget("keep"), { code: "WIDGET_NOT_FOUND" });
});

test("deleting the last widget during a failed poll leaves a healthy empty configuration", async () => {
  let failRequest;
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets: [{ id: "last" }],
    fetchImpl: () => new Promise((_resolve, reject) => { failRequest = reject; }) });
  const pending = poller.poll();
  poller.removeWidget("last");
  failRequest(new Error("network failure"));
  await pending;
  assert.equal(poller.getSnapshot().status, "idle");
  assert.equal(poller.getSnapshot().error, null);
});

test("bulk deletion during an in-flight batched poll clears values and skips unread batches", async () => {
  let finishRequest;
  const requests = [];
  const removed = [];
  const widgets = Array.from({ length: 502 }, (_, index) => ({ id: `floor/point-${index}`, writable: true }));
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).ids);
      return new Promise((resolve) => { finishRequest = resolve; });
    } });
  poller.on("removed", (event) => removed.push(event));
  const pending = poller.poll();
  assert.equal(poller.getSnapshot().widgets[0].group, "floor");
  assert.deepEqual(poller.removeAllWidgets(), { ids: widgets.map(({ id }) => id) });
  finishRequest(jsonResponse({ values: requests[0].map((id) => ({ id, value: 42 })) }));
  await pending;
  await poller.poll();
  assert.equal(requests.length, 1);
  assert.deepEqual(poller.getSnapshot(), { status: "idle", syncedAt: null, error: null, widgets: [] });
  assert.deepEqual(removed, [{ ids: widgets.map(({ id }) => id) }]);
  await assert.rejects(poller.writeValue(widgets[0].id, 42), { code: "POINT_NOT_WRITABLE" });
  assert.deepEqual(poller.removeAllWidgets(), { ids: [] });
});

test("bulk selection removal keeps the remaining snapshot values and reads only retained widgets", async () => {
  const requests = [];
  const removed = [];
  const widgets = [{ id: "floor/one", group: "Floor", visible: false }, { id: "other/one", group: "Other" }, { id: "floor/two", group: "Floor" }];
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets,
    fetchImpl: async (_url, options) => {
      const ids = JSON.parse(options.body).ids;
      requests.push(ids);
      return jsonResponse({ values: ids.map((id) => ({ id, value: 42 })) });
    } });
  poller.on("removed", (event) => removed.push(event));
  await poller.poll();
  assert.deepEqual(poller.removeWidgets(["floor/one", "floor/two"]), { ids: ["floor/one", "floor/two"] });
  const snapshot = poller.getSnapshot();
  assert.equal(snapshot.status, "connected");
  assert.deepEqual(snapshot.widgets.map(({ id, value }) => ({ id, value })), [{ id: "other/one", value: 42 }]);
  await poller.poll();
  assert.deepEqual(requests.at(-1), ["other/one"]);
  assert.deepEqual(removed, [{ ids: ["floor/one", "floor/two"] }]);
});

test("automatic discovery traverses nested containers once and keeps all values beyond the manual limit", async () => {
  const requests = [];
  const progress = [];
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets: [],
    username: "dashboard", password: "secret",
    fetchImpl: async (url, options) => {
      const id = new URL(url).searchParams.get("id");
      requests.push(id);
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from("dashboard:secret").toString("base64")}`);
      return jsonResponse({ containers: [{
        containerItems: id === "" ? [{ id: "floor", name: "Floor" }, { id: "other", name: "Other" }]
          : id === "floor" ? [{ id: "floor", name: "Self" }, { id: "other", name: "Other" }, { id: "floor/room", name: "Room" }] : [],
        valueItems: id === "" ? Array.from({ length: 501 }, (_, i) => ({ id: `value-${i}`, name: `Value ${i}` }))
          : [{ id: "shared", name: "Shared", unit: "°C", writeable: 1 }],
      }], errors: [] });
    } });
  const result = await poller.discoverAllValues({ onProgress: (event) => progress.push(event) });
  assert.deepEqual(requests, ["", "floor", "other", "floor/room"]);
  assert.equal(result.values.length, 502);
  assert.equal(result.tree.filter((item) => item.kind === "value").length, 502);
  assert.deepEqual(result.tree.find((item) => item.id === "floor/room"), { id: "floor/room", name: "Room", kind: "container", parentId: "floor" });
  assert.equal(result.tree.find((item) => item.id === "shared").parentId, "floor");
  assert.deepEqual(progress.at(-1), { containers: 4, pending: 0, found: 502, failedBranches: 0 });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(poller.getSnapshot().widgets, []);
});

test("automatic discovery still fails when the root cannot be read", async () => {
  for (const payload of [{ containers: [], errors: [{ id: "root", message: "unavailable" }] }, {}]) {
    const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets: [], fetchImpl: async () => jsonResponse(payload) });
    await assert.rejects(poller.discoverAllValues(), { code: "INCOMPLETE_DISCOVERY" });
  }
  const demo = new PointPoller({ demoMode: true, widgets: [] });
  await assert.rejects(demo.discoverAllValues(), { code: "DEMO_MODE" });
});

test("automatic discovery skips broken branches, keeps partial results and continues through healthy siblings and descendants", async () => {
  const brokenIds = ["40https://brickschema.org/schema/Brick#Class", "http-failure", "malformed", "timeout", "partial"];
  const visited = [];
  const progress = [];
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets: [], timeoutMs: 10,
    fetchImpl: async (url, options) => {
      const id = new URL(url).searchParams.get("id");
      visited.push(id);
      if (id === "timeout") return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      if (id === "http-failure") return jsonResponse({}, 500);
      if (id === "malformed") return jsonResponse({});
      if (id === brokenIds[0]) return jsonResponse({ containers: [], errors: [{ id, message: "Cannot resolve ontology ID" }] });
      if (id === "") return jsonResponse({ containers: [{
        containerItems: [...brokenIds, "healthy"].map((child) => ({ id: child, name: child })),
        valueItems: [{ id: "root-value", name: "Root value" }],
      }] });
      if (id === "partial") return jsonResponse({ containers: [{
        containerItems: [{ id: "partial/child", name: "Child" }],
        valueItems: [{ id: "partial/value", name: "Readable partial value" }],
      }], errors: [{ id, message: "One item is unavailable" }] });
      return jsonResponse({ containers: [{ valueItems: [{ id: `${id}/value`, name: id }] }] });
    } });
  const result = await poller.discoverAllValues({ onProgress: (event) => progress.push(event) });
  assert.deepEqual(result.values.map((item) => item.id).sort(), ["root-value", "partial/value", "healthy/value", "partial/child/value"].sort());
  assert.equal(result.warnings.length, 5);
  assert.deepEqual(result.warnings.map((warning) => warning.id).sort(), brokenIds.sort());
  assert.equal(visited.includes("partial/child"), true);
  assert.equal(visited.includes("healthy"), true);
  assert.equal(result.tree.find((node) => node.id === brokenIds.find((id) => id.startsWith("40https"))).error, "Cannot resolve ontology ID");
  assert.match(result.tree.find((node) => node.id === "timeout").error, /timed out/);
  assert.equal(result.tree.find((node) => node.id === "partial/child").parentId, "partial");
  assert.equal(progress.at(-1).failedBranches, 5);
  assert.equal(progress.at(-1).pending, 0);
  assert.equal(progress.at(-1).found, 4);
});

test("polls a large discovered dashboard in bounded requests and emits one complete update", async () => {
  const widgets = Array.from({ length: 502 }, (_, index) => ({ id: `point-${index}/${"x".repeat(180)}` }));
  const requests = [];
  const updates = [];
  const poller = new PointPoller({ middlewareUrl: "http://middleware", widgets,
    fetchImpl: async (_url, options) => {
      assert.ok(Buffer.byteLength(options.body) < 60_000);
      const { ids } = JSON.parse(options.body);
      assert.ok(ids.length <= 500);
      requests.push(ids);
      return jsonResponse({ values: ids.map((id) => ({ id, value: 42 })) });
    } });
  poller.on("update", (payload) => updates.push(payload));
  const snapshot = await poller.poll();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.flat(), widgets.map((widget) => widget.id));
  assert.equal(snapshot.widgets.length, 502);
  assert.equal(snapshot.widgets.every((widget) => widget.value === 42 && widget.error === null), true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].widgets.length, 502);
});
