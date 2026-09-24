const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TelemetryClient, normalizeResponse } = require("../lib/telemetry");
const { createApp } = require("../app");

const options = { historyItemId: "03/trend", timeFrom: "2026-09-21T02:00:00+02:00", timeTo: "2026-09-22T02:00:00+02:00" };
const history = (records, more = false) => ({
  GetHistoryResponseStatus: { MoreDataAvailable: more, MoreDataRef: more ? "458242222080000241" : "" },
  GetHistoryHistoryRecords: { Unit: "°C", ValueItemId: "01/value", List: { HistoryRecord: records } },
});

test("normalizes EWS history arrays, singleton records, zero and empty results", () => {
  const record = { TimeStamp: "2026-09-21T00:00:00Z", Value: 0, State: 0 };
  for (const input of [record, [record]]) {
    const result = normalizeResponse("history", history(input, true));
    assert.deepEqual(result.rows, [{ timestamp: record.TimeStamp, value: 0, state: 0 }]);
    assert.equal(result.moreDataRef, "458242222080000241");
    assert.equal(result.unit, "°C");
  }
  assert.deepEqual(normalizeResponse("history", history(undefined)).rows, []);
});

test("normalizes actual alarm field casing and reports EWS errors and invalid responses", () => {
  const result = normalizeResponse("alarms", {
    GetAlarmEventsResponseStatus: { MoreDataAvailable: false, NeedsRefresh: true },
    GetAlarmEventsAlarmEvents: { AlarmEvent: { ID: "alarm-1", SourceID: "02/source", SourceName: "Source", Message: "<script>untrusted</script>", Priority: 0, State: 2, TimeStampTransition: "2026-09-21T00:00:00Z" } },
  });
  assert.equal(result.rows[0].id, "alarm-1");
  assert.equal(result.rows[0].priority, 0);
  assert.equal(result.needsRefresh, true);
  assert.throws(() => normalizeResponse("history", { GetHistoryErrorResults: { ErrorResult: { Message: "Unknown history ID" } } }), /Unknown history ID/);
  assert.throws(() => normalizeResponse("history", {}), /neprepoznatljiv/);
  assert.throws(() => normalizeResponse("history", { GetHistoryResponseStatus: { MoreDataAvailable: true } }), /nastavak/);
});

test("dashboard HTTP routes preserve query and continuation, authenticate upstream and serve local assets", async (t) => {
  const calls = [];
  const config = { middlewareUrl: "https://middleware.test", username: "tester", password: "private-password", demoMode: false, widgets: [] };
  const telemetry = new TelemetryClient(config, async (url, request) => {
    calls.push({ url, ...request });
    return { ok: true, json: async () => history({ TimeStamp: "2026-09-21T00:00:00Z", Value: 23, State: 0 }, calls.length === 1) };
  });
  const poller = new EventEmitter();
  poller.getSnapshot = () => ({ widgets: [] });
  const server = createApp({ poller, config, telemetry }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, contentType = "application/json") => fetch(`${base}/api/history/query`, { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body) });
  const first = await (await post(options)).json();
  const second = await (await post({ ...options, moreDataRef: first.moreDataRef })).json();
  assert.equal(second.moreDataAvailable, false);
  assert.equal(calls[0].url, "https://middleware.test/api/history/query");
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("tester:private-password").toString("base64")}`);
  assert.deepEqual(JSON.parse(calls[1].body), { historyItemId: "03/trend", timeFrom: "2026-09-21T00:00:00.000Z", timeTo: "2026-09-22T00:00:00.000Z", moreDataRef: "458242222080000241" });
  assert.ok(!JSON.stringify(first).includes(config.password));
  for (const body of [{}, { ...options, timeTo: options.timeFrom }, { ...options, timeFrom: "invalid" }, { ...options, moreDataRef: 123 }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(options, "text/plain")).status, 415);
  assert.equal(calls.length, 2);
  for (const asset of ["/trends.html", "/trends.js", "/vendor/datatables.js", "/vendor/datatables.css", "/vendor/chart.js"]) {
    assert.equal((await fetch(base + asset)).status, 200, asset);
  }
});

test("trend discovery reads dedicated history IDs and encodes container paths", async () => {
  const client = new TelemetryClient({ middlewareUrl: "http://middleware", username: "u", password: "p" }, async (url) => {
    assert.equal(url, "http://middleware/api/containers?id=00%2Ffolder%20%26%20other");
    return { ok: true, json: async () => ({ containers: [{ containerItems: [{ id: "00/child", name: "Child" }], historyItems: [{ Id: "03/history", Name: "History", ValueItemId: "01/value" }] }], errors: [] }) };
  });
  assert.deepEqual((await client.browse("00/folder & other")).items.map(({ id, kind }) => ({ id, kind })), [{ id: "00/child", kind: "container" }, { id: "03/history", kind: "history" }]);
});

test("network and authentication failures are explicit and never expose secrets", async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => { throw new Error("private-password"); }, async () => { throw new DOMException("timeout", "TimeoutError"); }]) {
    const client = new TelemetryClient({ middlewareUrl: "http://middleware", password: "private-password" }, fetchImpl);
    await assert.rejects(client.query("alarms", {}), (error) => error.status >= 500 && !error.message.includes("private-password"));
  }
});

test("reports SOAP faults even when an older middleware returns HTTP 200", async () => {
  const client = new TelemetryClient({ middlewareUrl: "http://middleware" }, async () => ({ ok: true, json: async () => ({ error: "SOAP-ENV:Server: Invalid ID", soapFault: { reason: "Invalid ID" } }) }));
  await assert.rejects(client.query("history", options), (error) => error.status === 502 && error.message.includes("Invalid ID"));
});

test("demo works without contacting the controller", async () => {
  const client = new TelemetryClient({ demoMode: true }, () => { throw new Error("must not fetch"); });
  assert.equal((await client.query("history", options)).rows.length, 49);
  assert.equal((await client.query("alarms", {})).rows[0].type, "Demo");
});
