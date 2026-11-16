const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../middleware/app");
const { createEwsClient, parseGetValuesResponse } = require("../middleware/ewsClient");

const challenge = { "www-authenticate": 'Digest realm="ews", nonce="abc", qop="auth"' };
const valuesXml = (value) => `<Envelope><Body><GetValuesResponse><GetValuesItems><ValueItem>
  <Id>01/a</Id><State>0</State><Value>${value}</Value></ValueItem></GetValuesItems></GetValuesResponse></Body></Envelope>`;
const client = (extra = {}) => createEwsClient({ serviceUrl: "http://ews.invalid/x", username: "u", password: "p", ...extra });

test("text values that only look numeric stay text", () => {
  const read = (value) => parseGetValuesResponse(valuesXml(value)).values[0].value;
  assert.deepEqual(["0012", "0x1F", "1e3", "21.5", "7"].map(read), ["0012", "0x1F", "1e3", 21.5, 7]);
});

test("a non-SOAP error reply is reported by its HTTP status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Unauthorized</html>", { status: 401, headers: challenge }));
  await assert.rejects(client().getValues(["a"]), (error) => error.status === 401 && /EWS request failed: 401/.test(error.message));
});

test("request fields cannot add XML to the SOAP body", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    bodies.push(options.body);
    return new Response("", { status: 500 });
  });
  await assert.rejects(client().getAlarmEvents({ priorityFrom: "1</PriorityFrom><Injected/>", metadata: 'x" evil="1' }));
  assert.ok(!bodies[0].includes("<Injected/>") && !bodies[0].includes("evil="));
  assert.ok(bodies[0].includes('metadata="false"'));
});

test("the digest challenge is reused with a rising counter and renewed on 401", async (t) => {
  const seen = [];
  let expire = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const header = options.headers.Authorization || "";
    seen.push(/nc=(\w+)/.exec(header)?.[1] ?? null);
    if (!header || expire) { expire = false; return new Response("", { status: 401, headers: challenge }); }
    return new Response(valuesXml("1"));
  });
  const ews = client();
  await ews.getValues(["a"]);
  await ews.getValues(["a"]);
  expire = true;
  await ews.getValues(["a"]);
  assert.deepEqual(seen, [null, "00000001", "00000002", "00000003", "00000001"]);
});

test("a slow controller call ends with 504, and stops when the REST client leaves", async (t) => {
  const keepAlive = setInterval(() => {}, 1000); // mocked fetch does not hold the event loop
  t.after(() => clearInterval(keepAlive));
  const aborted = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", (url, options) => new Promise((resolve, reject) => {
    calls += 1;
    options.signal.addEventListener("abort", () => { aborted.push(url); reject(options.signal.reason); });
  }));
  await assert.rejects(client({ requestTimeoutMs: 20 }).getValues(["a"]), (error) => error.status === 504);

  const app = createApp({ ews: client(), middlewareAuth: (req, res, next) => next(), swaggerDocument: {} });
  const server = app.listen(0);
  t.after(() => server.close());
  const request = http.request({ port: server.address().port, path: "/api/values/read", method: "POST",
    headers: { "Content-Type": "application/json" } });
  request.on("error", () => {});
  request.end(JSON.stringify({ ids: ["a"] }));
  while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  request.destroy();
  while (aborted.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
});

test("a POST without a body is a 400, not a 500", async (t) => {
  const app = createApp({ ews: {}, middlewareAuth: (req, res, next) => next(), swaggerDocument: {} });
  const server = app.listen(0);
  t.after(() => server.close());
  for (const path of ["/api/values/read", "/api/items/read", "/api/enums/read", "/api/history/query", "/api/subscriptions"]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST" });
    assert.equal(response.status, 400, path);
  }
});
