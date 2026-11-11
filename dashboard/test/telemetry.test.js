const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { TelemetryClient, normalizeResponse, queryOptions } = require("../lib/telemetry/telemetry");
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

test("XML paging flags accept exactly true/false/1/0 and malformed flags never imply completion", () => {
  for (const flag of [true, 1, "true", "1", " 1 "]) {
    for (const kind of ["history", "alarms"]) {
      const prefix = kind === "history" ? "GetHistory" : "GetAlarmEvents";
      const result = normalizeResponse(kind, { [`${prefix}ResponseStatus`]: { MoreDataAvailable: flag, MoreDataRef: "000123", NeedsRefresh: flag } });
      assert.equal(result.moreDataAvailable, true);
      assert.equal(result.moreDataRef, "000123");
      if (kind === "alarms") assert.equal(result.needsRefresh, true);
    }
  }
  for (const flag of [false, 0, "false", "0", " 0 "]) {
    const result = normalizeResponse("alarms", {GetAlarmEventsResponseStatus:{MoreDataAvailable:flag,MoreDataRef:"stale",NeedsRefresh:flag}});
    assert.equal(result.moreDataAvailable,false);
    assert.equal(result.moreDataRef,null);
    assert.equal(result.needsRefresh,false);
  }
  for (const flag of [undefined, null, "", "yes", "FALSE", 2, {}, []]) {
    assert.throws(()=>normalizeResponse("history",{GetHistoryResponseStatus:{MoreDataAvailable:flag}}),/neispravnu XML/);
  }
  assert.throws(()=>normalizeResponse("alarms",{GetAlarmEventsResponseStatus:{MoreDataAvailable:false,NeedsRefresh:"invalid"}}),/neispravnu XML/);
  for (const token of [undefined, "", 123, {}, true]) {
    assert.throws(()=>normalizeResponse("history",{GetHistoryResponseStatus:{MoreDataAvailable:true,MoreDataRef:token}}),/nastavak/);
  }
  assert.equal(queryOptions("history",{...options,historyItemId:" 0007 ",moreDataRef:"  "}).moreDataRef,"  ");
  assert.equal(queryOptions("history",{...options,historyItemId:" 0007 "}).historyItemId," 0007 ");
});

test("SOAP XML passes through middleware and dashboard HTTP with exact cursors and IDs", async t => {
  const http = require("node:http");
  const {createApp: middlewareApp} = require("../../middleware/app");
  const {createEwsClient, escapeXml} = require("../../middleware/ewsClient");
  const {createMiddlewareAuth, createPasswordHash} = require("../../middleware/middlewareAuth");
  const requests=[];
  let token, kind, page;
  const controller=http.createServer((req,res)=>{
    let body='';
    req.setEncoding('utf8');req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      requests.push(body);
      const prefix=kind==='history'?'GetHistory':'GetAlarmEvents';
      const more=page++===0;
      const records=kind==='history'
        ? `<GetHistoryHistoryRecords><Unit>°C</Unit><ValueItemId> 00042 </ValueItemId><List><HistoryRecord><TimeStamp>2026-11-11T00:00:00Z</TimeStamp><Value>${more?'0':'23.50'}</Value><State>0</State></HistoryRecord></List></GetHistoryHistoryRecords>`
        : `<GetAlarmEventsAlarmEvents><AlarmEvent><ID>000012</ID><SourceID> 00042 </SourceID><SourceName>Source</SourceName><Message>Message</Message><Priority>0</Priority><State>2</State><Type>0005</Type></AlarmEvent></GetAlarmEventsAlarmEvents>`;
      res.writeHead(200,{'Content-Type':'application/soap+xml'});
      res.end(`<Envelope><Body><${prefix}Response><${prefix}ResponseStatus><MoreDataAvailable>${more?'1':'0'}</MoreDataAvailable><MoreDataRef>${escapeXml(token)}</MoreDataRef><NeedsRefresh>0</NeedsRefresh></${prefix}ResponseStatus>${records}</${prefix}Response></Body></Envelope>`);
    });
  });
  async function listen(server){
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const controllerUrl=await listen(controller);
  const ews=createEwsClient({serviceUrl:controllerUrl,username:'ews-test',password:'ews-test'});
  const middlewareUrl=await listen(http.createServer(middlewareApp({ews,middlewareAuth:createMiddlewareAuth({username:'test',passwordHash:createPasswordHash('test-password')})})));
  const config={middlewareUrl,username:'test',password:'test-password',demoMode:false,widgets:[]};
  const poller=new EventEmitter();poller.getSnapshot=()=>({widgets:[]});
  const dashboardUrl=await listen(http.createServer(createApp({poller,config})));
  for (kind of ['history','alarms']) {
    for(token of ['000123',' 0000 / &+ ž <tag> ','0','  ']) {
      page=0;requests.length=0;
      const query=kind==='history'?{...options,historyItemId:' 0007 '}:{};
      const post=async body=>{
        const r=await fetch(`${dashboardUrl}/api/${kind}/query`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        assert.equal(r.status,200);return r.json();
      };
      const first=await post(query);
      assert.equal(first.moreDataAvailable,true);
      assert.equal(first.moreDataRef,token);
      const last=await post({...query,moreDataRef:first.moreDataRef});
      assert.equal(last.moreDataAvailable,false);
      assert.equal(last.moreDataRef,null);
      assert.equal(page,2);
      assert.ok(requests[1].includes(`<MoreDataRef>${escapeXml(token)}</MoreDataRef>`));
      if(kind==='history') {
        assert.ok(requests[0].includes('<Id> 0007 </Id>'));
        assert.equal(first.valueItemId,' 00042 ');
        assert.deepEqual(first.rows.map(r=>[r.value,r.state]),[[0,0]]);
        assert.equal(last.rows[0].value,23.5);
      } else {
        assert.equal(first.rows[0].id,'000012');
        assert.equal(first.rows[0].sourceId,' 00042 ');
        assert.equal(first.rows[0].type,'0005');
        assert.equal(first.rows[0].priority,0);
        assert.equal(first.rows[0].state,2);
        assert.equal(first.needsRefresh,false);
      }
    }
  }
  const client=new TelemetryClient(config,async url=>{
    assert.equal(new URL(url).searchParams.get('id'),' 00042 ');
    return {ok:true,json:async()=>({containers:[],errors:[]})};
  });
  await client.browse(' 00042 ');
});

test("all telemetry SOAP responses retain opaque strings and type only measurement/status fields", () => {
  const {parseOperationResponse}=require('../../middleware/ewsClient');
  for(const prefix of ['GetHistory','GetAlarmEvents','GetUpdatedAlarmEvents','GetAlarmHistory']) {
    const responseName=prefix+'Response';
    const result=parseOperationResponse(`<Envelope><Body><${responseName}><${prefix}ResponseStatus><MoreDataAvailable>false</MoreDataAvailable><MoreDataRef> 000123 </MoreDataRef></${prefix}ResponseStatus><Records><HistoryRecord><Value>-1.25e2</Value><State>0</State></HistoryRecord><HistoryRecord><Value>off</Value><State>2</State></HistoryRecord><HistoryRecord><Value></Value><State>0</State></HistoryRecord><AlarmEvent><ID>000012</ID><SourceID>000034</SourceID><Priority>0</Priority></AlarmEvent></Records></${responseName}></Body></Envelope>`,responseName);
    assert.equal(result[prefix+'ResponseStatus'].MoreDataRef,' 000123 ');
    assert.equal(result[prefix+'ResponseStatus'].MoreDataAvailable,false);
    assert.deepEqual(result.Records.HistoryRecord.map(r=>r.Value),[-125,'off','']);
    assert.deepEqual(result.Records.HistoryRecord.map(r=>r.State),[0,2,0]);
    assert.equal(result.Records.AlarmEvent.ID,'000012');
    assert.equal(result.Records.AlarmEvent.SourceID,'000034');
    assert.equal(result.Records.AlarmEvent.Priority,0);
  }
});
