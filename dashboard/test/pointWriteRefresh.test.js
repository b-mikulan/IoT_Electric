const test = require("node:test");
const assert = require("node:assert/strict");
const { PointPoller } = require("../lib/pointPoller");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, { onRead, onWrite, intervalMs = 15_000 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const reads = [];
  const writes = [];
  const syncs = [];
  const updates = [];
  const values = { setpoint: 20, sibling: 21, hidden: 0 };
  const poller = new PointPoller({
    middlewareUrl: "http://middleware.test",
    widgets: [
      { id: "setpoint", writable: true },
      { id: "sibling" },
      { id: "hidden", visible: false },
    ],
    intervalMs,
    now: () => new Date(1_700_000_000_000 + reads.length * 1_000),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/api/values/read")) {
        reads.push(body.ids);
        const response = jsonResponse({
          values: body.ids.map((id) => ({ id, value: values[id], state: 0 })), errors: [],
        });
        return onRead ? onRead(reads.length, response) : response;
      }
      assert.ok(url.endsWith("/api/values/write"));
      writes.push(body.items[0]);
      const response = jsonResponse({ results: [{ id: body.items[0].id, success: true }] });
      return onWrite ? onWrite(writes.length, response) : response;
    },
  });
  poller.on("sync", (payload) => syncs.push(payload));
  poller.on("update", (payload) => updates.push(payload));
  t.after(() => poller.stop());
  return { poller, reads, writes, syncs, updates, values };
}

test("refreshes every configured widget exactly two seconds after successful acknowledgement", async (t) => {
  const acknowledgement = deferred();
  const f = fixture(t, { onWrite: async (count, response) => { await acknowledgement.promise; return response; } });
  await f.poller.poll();

  const writing = f.poller.writeValue("setpoint", 25);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.reads.length, 1, "sending a command alone does not start its refresh countdown");

  acknowledgement.resolve();
  assert.equal((await writing).success, true);
  Object.assign(f.values, { setpoint: 25, sibling: 24, hidden: 1 });
  t.mock.timers.tick(1_999);
  await flush();
  assert.equal(f.reads.length, 1);

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(f.reads, [["setpoint", "sibling", "hidden"], ["setpoint", "sibling", "hidden"]]);
  assert.deepEqual(f.poller.getSnapshot().widgets.map(({ id, value }) => [id, value]),
    [["setpoint", 25], ["sibling", 24], ["hidden", 1]]);
  assert.equal(f.syncs.length, 2);
});

test("publishes a completed refresh even when all widget values are unchanged", async (t) => {
  const f = fixture(t);
  await f.poller.poll();
  const before = f.poller.getSnapshot();
  await f.poller.writeValue("setpoint", 20);

  t.mock.timers.tick(2_000);
  await flush();

  const after = f.poller.getSnapshot();
  assert.equal(f.reads.length, 2);
  assert.equal(f.syncs.length, 2);
  assert.notEqual(after.syncedAt, before.syncedAt);
  assert.equal(f.updates.length, 1, "unchanged values do not create false change events");
  assert.deepEqual(after.widgets.map(({ updatedAt }) => updatedAt), before.widgets.map(({ updatedAt }) => updatedAt));
});

for (const [name, reply, code] of [
  ["HTTP failure", () => jsonResponse({}, 503), "MIDDLEWARE_WRITE_FAILED"],
  ["missing matching result", () => jsonResponse({ results: [{ id: "different", success: true }] }), "MISSING_WRITE_RESULT"],
  ["controller rejection", () => jsonResponse({ results: [{ id: "setpoint", success: false }] }), "CONTROLLER_REJECTED"],
  ["network failure", () => { throw new Error("Network unavailable"); }, "MIDDLEWARE_WRITE_FAILED"],
]) {
  test(`does not schedule a refresh after ${name}`, async (t) => {
    const f = fixture(t, { onWrite: reply });
    await f.poller.poll();
    await assert.rejects(f.poller.writeValue("setpoint", 25), { code });

    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(f.reads.length, 1);
    assert.equal(f.syncs.length, 1);
  });
}

test("waits for a read already in flight and then starts a fresh full read", async (t) => {
  const oldRead = deferred();
  const f = fixture(t, { onRead: (count, response) => count === 2 ? oldRead.promise : response });
  await f.poller.poll();
  const pendingRead = f.poller.poll();
  assert.equal(f.reads.length, 2);
  await f.poller.writeValue("setpoint", 25);

  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(f.reads.length, 2, "the existing request finishes before another read begins");

  Object.assign(f.values, { setpoint: 25, sibling: 24 });
  oldRead.resolve(jsonResponse({ values: [{ id: "setpoint", value: 20, state: 0 }], errors: [] }));
  await pendingRead;
  await flush();

  assert.equal(f.reads.length, 3, "the old request is not reused as post-command refresh");
  assert.deepEqual(f.reads[2], ["setpoint", "sibling", "hidden"]);
  assert.equal(f.poller.getSnapshot().widgets.find(({ id }) => id === "sibling").value, 24);
});

test("stop cancels a refresh whose delay has not expired", async (t) => {
  const f = fixture(t);
  await f.poller.poll();
  await f.poller.writeValue("setpoint", 25);
  t.mock.timers.tick(1_999);
  f.poller.stop();

  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.reads.length, 1);
});

test("stop cancels a delayed refresh already waiting for an older read", async (t) => {
  const oldRead = deferred();
  const f = fixture(t, { onRead: (count, response) => count === 2 ? oldRead.promise : response });
  await f.poller.poll();
  const pendingRead = f.poller.poll();
  await f.poller.writeValue("setpoint", 25);
  t.mock.timers.tick(2_000);
  await flush();
  f.poller.stop();

  oldRead.resolve(jsonResponse({ values: [], errors: [] }));
  await pendingRead;
  await flush();
  assert.equal(f.reads.length, 2);
});

test("an acknowledgement received after stop does not schedule another refresh", async (t) => {
  const acknowledgement = deferred();
  const f = fixture(t, { onWrite: async (count, response) => { await acknowledgement.promise; return response; } });
  await f.poller.poll();
  const writing = f.poller.writeValue("setpoint", 25);
  f.poller.stop();
  acknowledgement.resolve();
  assert.equal((await writing).success, true);

  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.reads.length, 1);
});

test("each successful acknowledgement keeps its own two second refresh deadline", async (t) => {
  const f = fixture(t);
  await f.poller.poll();
  await f.poller.writeValue("setpoint", 25);
  t.mock.timers.tick(1_000);
  await f.poller.writeValue("setpoint", 26);

  t.mock.timers.tick(999);
  await flush();
  assert.equal(f.reads.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.reads.length, 2, "a newer command does not postpone the earlier refresh");
  t.mock.timers.tick(999);
  await flush();
  assert.equal(f.reads.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.reads.length, 3);
});

test("post-command refresh preserves the normal polling interval", async (t) => {
  const f = fixture(t, { intervalMs: 5_000 });
  f.poller.start();
  await flush();
  await f.poller.writeValue("setpoint", 25);

  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(f.reads.length, 2);
  t.mock.timers.tick(2_999);
  await flush();
  assert.equal(f.reads.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.reads.length, 3, "regular polling still runs at its original deadline");
});
