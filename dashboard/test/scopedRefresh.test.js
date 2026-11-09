const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { resolveManualRefreshScope } = require("../lib/telemetry/refreshScope");
const { PointPoller } = require("../lib/telemetry/pointPoller");
const { loadConfig } = require("../lib/config");
const { createApp } = require("../app");

const point = (owner, name = "LtPct", visible = true) => ({ id: `01/ES/Zones/${owner}/Values/${name}`, label: name, visible, writable: false });
const widgets = [point("L101"), point("L101", "LtSts", false), point("L102"), point("L201"), point("ZX01"), point("Loose")];
const options = {
  deviceSettings: ["L101", "L102", "L201", "ZX01"].map((owner, i) => ({ key: `ES/Zones/${owner}`, room: ["k1", "office", "k2", "zx"][i] })),
  floors: [{ id: "f1", name: "1. kat A" }, { id: "f2", name: "1. kat B" }, { id: "empty", name: "Prazan kat" }],
  roomDetails: [{ id: "k1", name: "Kitchen", floorId: "f1" }, { id: "office", name: "Office", floorId: "f1" },
    { id: "k2", name: "Kitchen", floorId: "f2" }, { id: "zx", name: "Zone", floorId: null }],
};
const json = body => ({ ok: true, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));
function poller(fetchImpl, extra = {}) {
  return new PointPoller({ middlewareUrl: "http://fixture", username: "fixture", password: "fixture", widgets,
    readBatchSize: 256, readBatchDelayMs: 0, fetchImpl, ...extra });
}
const values = init => json({ values: JSON.parse(init.body).ids.map(id => ({ id, value: 25, state: 0 })) });

test("manual scopes follow stable identities and include hidden owned points without crossing same-named rooms", () => {
  const resolve = target => resolveManualRefreshScope(widgets, options, target);
  assert.deepEqual(resolve({ scope: "device", id: "ES/Zones/L101" }), { ids: widgets.slice(0, 2).map(p => p.id), deviceCount: 1 });
  assert.deepEqual(resolve({ scope: "room", id: "k1" }).ids, widgets.slice(0, 2).map(p => p.id));
  assert.deepEqual(resolve({ scope: "floor", id: "f1" }), { ids: widgets.slice(0, 3).map(p => p.id), deviceCount: 2 });
  assert.deepEqual(resolve({ scope: "floor", id: null }).ids, [widgets[4].id]);
  assert.deepEqual(resolve({ scope: "room", id: null }).ids, [widgets[5].id]);
  const moved = { ...options, deviceSettings: options.deviceSettings.map((device, i) => i === 0 ? { ...device, room: "k2" } : device) };
  assert.deepEqual(resolveManualRefreshScope(widgets, moved, { scope: "floor", id: "f1" }).ids, [widgets[2].id]);
  for (const target of [null, [], {}, { scope: "building", id: "f1" }, { scope: "floor" }, { scope: "device", id: null },
    { scope: "room", id: "" }, { scope: "room", id: "k1", ids: [widgets[3].id] }]) {
    assert.throws(() => resolve(target), error => error.status === 400);
  }
  assert.throws(() => resolve({ scope: "room", id: "Kitchen" }), error => error.status === 404);
  assert.throws(() => resolve({ scope: "floor", id: "empty" }), error => error.code === "EMPTY_REFRESH_SCOPE");
});

test("manual scoped reads work during pause, retain full freshness and report point-level errors", async () => {
  const reads = [];
  let failPoint = false, time = 0;
  const service = poller(async (_url, init) => {
    const ids = JSON.parse(init.body).ids; reads.push(ids);
    return json({ values: ids.filter(id => !failPoint || id !== widgets[1].id).map(id => ({ id, value: 25, state: 0 })), errors: failPoint ? [{ id: widgets[1].id, error: "missing" }] : [] });
  }, { now: () => new Date(time++ * 1000) });
  const before = await service.poll();
  service.setPaused(true); failPoint = true;
  const result = await service.refreshScope(widgets.slice(0, 2).map(p => p.id));
  assert.equal(result.pointCount, 2);
  assert.equal(result.errorCount, 1);
  assert.notEqual(result.readAt, before.syncedAt);
  assert.equal(service.getSnapshot().syncedAt, before.syncedAt);
  assert.deepEqual(service.getSnapshot().widgets[2], before.widgets[2]);
  assert.deepEqual(reads[1], widgets.slice(0, 2).map(p => p.id));
  await service.poll(); assert.equal(reads.length, 2);
});

test("a scoped request yields a full read after its current batch and never overlaps upstream requests", async () => {
  let entered, release, active = 0, maximum = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const reads = [];
  const service = poller(async (_url, init) => {
    active++; maximum = Math.max(maximum, active); reads.push(JSON.parse(init.body).ids);
    if (reads.length === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    active--; return values(init);
  }, { readBatchSize: 1 });
  const full = service.poll(); await ready;
  const room = service.refreshScope([widgets[2].id, widgets[3].id]);
  release(); await Promise.all([full, room]);
  assert.deepEqual(reads, [[widgets[0].id], [widgets[2].id], [widgets[3].id]]);
  assert.equal(maximum, 1);
  assert.equal(service.getSnapshot().syncedAt, null);
  assert.equal(service.getPollingState().active, false);
});

test("queued manual requests retain their own failure even when a later scope succeeds", async () => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const service = poller(async (_url, init) => {
    if (JSON.parse(init.body).ids.includes(widgets[0].id)) {
      entered(); await new Promise(resolve => { release = resolve; }); throw new Error("device unavailable");
    }
    return values(init);
  });
  const first = service.refreshScope([widgets[0].id]);
  const rejected = assert.rejects(first, error => error.status === 502 && /device unavailable/.test(error.message));
  await ready;
  const second = service.refreshScope([widgets[3].id]);
  release(); await rejected;
  assert.equal((await second).pointCount, 1);
  assert.equal(service.getSnapshot().widgets[0].readAt, undefined);
  assert(service.getSnapshot().widgets[3].readAt);
});

test("stopping a queued scope reports cancellation instead of cached success", async () => {
  let release;
  const service = poller(async (_url, init) => { await new Promise(resolve => { release = resolve; }); return values(init); });
  const request = service.refreshScope([widgets[0].id]); await tick();
  const rejected = assert.rejects(request, error => error.code === "REFRESH_CANCELLED");
  service.stop(); release(); await rejected;
});

test("scoped HTTP refresh validates targets, awaits completion and does not turn a transport failure into success", async t => {
  const reads = [];
  let failed = false;
  const service = poller(async (_url, init) => {
    reads.push(JSON.parse(init.body).ids);
    if (failed) throw new Error("fixture offline");
    return values(init);
  });
  const config = loadConfig({ DEMO_MODE: "false", WIDGETS_JSON: JSON.stringify(widgets), MIDDLEWARE_USER: "fixture", MIDDLEWARE_PASSWORD: "fixture" });
  const app = createApp({ poller: service, config, deviceWidgetStore: { enabled: false, devices: options.deviceSettings, ...options },
    deviceMetadata: { groupingMetadata: () => ({}), roomNames: () => [] } });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { service.stop(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = target => fetch(base + "/api/dashboard/refresh-scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
  service.setPaused(true);
  for (const target of [{ scope: "device", id: "ES/Zones/L101" }, { scope: "room", id: "k1" }, { scope: "floor", id: "f1" }]) {
    const response = await post(target);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.pointCount, target.scope === "floor" ? 3 : 2);
    assert.equal(body.deviceCount, target.scope === "floor" ? 2 : 1);
    assert.equal(body.errorCount, 0);
    assert(body.readAt);
    assert.equal(body.widgets, undefined);
  }
  assert.equal(service.getPollingState().paused, true);
  assert.equal(reads.flat().includes(widgets[3].id), false);
  assert.equal((await post({ scope: "floor" })).status, 400);
  assert.equal((await post({ scope: "room", id: "Kitchen" })).status, 404);
  assert.equal((await post({ scope: "floor", id: "empty" })).status, 409);
  assert.equal(reads.length, 3);
  const before = service.getSnapshot(); failed = true;
  const response = await post({ scope: "device", id: "ES/Zones/L101" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "SCOPED_REFRESH_FAILED");
  assert.deepEqual(service.getSnapshot(), before);
});
