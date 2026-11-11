const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMiddlewareAuth,
  createPasswordHash,
  parseBasicAuthorization,
  verifyPassword,
} = require("../middleware/middlewareAuth");

const TEST_SALT = "00112233445566778899aabbccddeeff";
const PASSWORD_HASH = createPasswordHash("test-password", TEST_SALT);

function basicHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function createRequest(authorization, ip = "127.0.0.1") {
  return {
    ip,
    get(name) {
      return name.toLowerCase() === "authorization" ? authorization : undefined;
    },
  };
}

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("creates and verifies a scrypt password hash", async () => {
  const hash = createPasswordHash("test-password", TEST_SALT);

  assert.equal(await verifyPassword("test-password", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

function authFixture(limits = {}, dependencies = {}) {
  const authenticate = createMiddlewareAuth({ username: "bruno", passwordHash: PASSWORD_HASH, limits }, dependencies);
  const call = async (password = "wrong", ip, username = "bruno") => {
    const response = createResponse();
    await authenticate(createRequest(basicHeader(username, password), ip), response, () => { response.allowed = true; });
    return response;
  };
  return { authenticate, call };
}

test("password verification yields to the event loop", async () => {
  let completed = false;
  const operation = verifyPassword("test-password", PASSWORD_HASH).then(result => { completed = true; return result; });
  assert.equal(completed, false);
  // No synchronous crypto may run before returning the pending Promise.
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(await operation, true);
});

test("limits failures per client, isolates clients and resets after the window", async () => {
  let time = 1000, calls = 0;
  const {call} = authFixture({maxFailures:2}, {now:()=>time, verify:async()=>{calls++;return false;}});
  assert.equal((await call()).statusCode, 401);
  assert.equal((await call()).statusCode, 401);
  const blocked = await call();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["retry-after"], "60");
  assert.equal(calls, 2);
  assert.equal((await call("wrong", "127.0.0.2")).statusCode, 401);
  time += 60_000;
  assert.equal((await call()).statusCode, 401);
  assert.equal(calls, 4);
});

test("wrong usernames consume the same client budget without running scrypt", async () => {
  let calls = 0;
  const {call} = authFixture({maxFailures:1}, {verify:async()=>{calls++;return false;}});
  assert.equal((await call("wrong", undefined, "unknown")).statusCode, 401);
  assert.equal((await call()).statusCode, 429);
  assert.equal(calls, 0);
});

test("bounds parallel work and reserves per-client attempts before awaiting", async () => {
  const releases=[];
  const {call}=authFixture({maxConcurrent:2,maxFailures:1},{verify:()=>new Promise(resolve=>releases.push(resolve))});
  const first=call("wrong", "a");
  assert.equal((await call("wrong", "a")).statusCode,429);
  const second=call("wrong", "b");
  assert.equal((await call("wrong", "c")).statusCode,429);
  assert.equal(releases.length,2);
  releases.shift()(false);
  assert.equal((await first).statusCode,401);
  const third=call("wrong", "c");
  releases.shift()(false); releases.shift()(false);
  assert.equal((await second).statusCode,401);
  assert.equal((await third).statusCode,401);
});

test("global budget bounds verification across changing client addresses", async () => {
  let time=1000, calls=0;
  const {call}=authFixture({maxVerifications:2},{now:()=>time,verify:async()=>{calls++;return false;}});
  await call("wrong","a"); await call("wrong","b");
  assert.equal((await call("wrong","c")).statusCode,429);
  assert.equal(calls,2);
  time+=60_000;
  assert.equal((await call("wrong","c")).statusCode,401);
});

test("successful credentials are cached while invalid attempts remain throttled", async () => {
  let time=1000, calls=0;
  const {call}=authFixture({maxFailures:1,maxVerifications:2},{now:()=>time,verify:async p=>{calls++;return p==='test-password';}});
  assert.equal((await call("test-password")).allowed,true);
  assert.equal((await call()).statusCode,401);
  assert.equal((await call()).statusCode,429);
  assert.equal((await call("test-password")).allowed,true);
  assert.equal(calls,2);
  time+=300_000;
  assert.equal((await call("test-password")).allowed,true);
  assert.equal(calls,3);
});

test("verification errors fail closed, release capacity and do not cache credentials", async () => {
  let calls=0;
  const {call}=authFixture({maxConcurrent:1},{verify:async()=>{calls++;if(calls===1)throw new Error('private crypto error');return true;}});
  const failed=await call("test-password");
  assert.equal(failed.statusCode,503);
  assert.equal(failed.allowed,undefined);
  assert.equal(JSON.stringify(failed.body).includes('private'),false);
  assert.equal((await call("test-password")).allowed,true);
  assert.equal(calls,2);
});

test("client tracking is bounded and expired entries free space", async () => {
  let time=1000;
  const {call}=authFixture({maxClients:1},{now:()=>time,verify:async()=>false});
  await call("wrong","a");
  assert.equal((await call("wrong","b")).statusCode,429);
  time+=60_000;
  assert.equal((await call("wrong","b")).statusCode,401);
});

test("rejects malformed configured hashes at startup", () => {
  for(const passwordHash of ['scrypt:bad', 'scrypt:aa:'+'00'.repeat(64)]) {
    assert.throws(()=>createMiddlewareAuth({username:'bruno',passwordHash}),/invalid MIDDLEWARE_PASSWORD_HASH/);
  }
});

test("health and Swagger remain reachable during verification; forwarded headers cannot bypass throttling", async t => {
  const { createApp } = require("../middleware/app");
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const authenticate = createMiddlewareAuth({username:'bruno',passwordHash:PASSWORD_HASH,limits:{maxFailures:1,maxConcurrent:1}}, {
    verify:()=>new Promise(resolve=>{release=resolve;entered();}),
  });
  const app=createApp({ews:{},middlewareAuth:authenticate});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>{release?.(false);return new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=(url,forwarded)=>fetch(base+url,{headers:{Authorization:basicHeader('bruno','wrong'),...(forwarded?{'X-Forwarded-For':forwarded}:{})},signal:AbortSignal.timeout(5000)});
  const pending=get('/api/info','192.0.2.1');
  await started;
  try {
    assert.equal((await get('/health')).status,200);
    assert.equal((await get('/api-docs/')).status,200);
    const blocked=await get('/api/info','192.0.2.2');
    assert.equal(blocked.status,429);
    assert.ok(Number(blocked.headers.get('retry-after'))>0);
  } finally { release(false); }
  assert.equal((await pending).status,401);
  assert.equal((await get('/api/info','192.0.2.3')).status,429);
});

test("parses Basic credentials and preserves colons in the password", () => {
  assert.deepEqual(parseBasicAuthorization(basicHeader("bruno", "one:two")), {
    username: "bruno",
    password: "one:two",
  });
});

test("rejects requests without credentials", () => {
  const passwordHash = createPasswordHash("test-password", TEST_SALT);
  const authenticate = createMiddlewareAuth({
    username: "bruno",
    passwordHash,
  });
  const response = createResponse();
  let nextCalled = false;

  authenticate(createRequest(undefined), response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.match(response.headers["www-authenticate"], /^Basic /);
  assert.deepEqual(response.body, { error: "Authentication required." });
  assert.equal(nextCalled, false);
});

test("rejects incorrect credentials", async () => {
  const passwordHash = createPasswordHash("test-password", TEST_SALT);
  const authenticate = createMiddlewareAuth({
    username: "bruno",
    passwordHash,
  });
  const response = createResponse();
  let nextCalled = false;

  await authenticate(
    createRequest(basicHeader("bruno", "wrong-password")),
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("allows correct credentials", async () => {
  const passwordHash = createPasswordHash("test-password", TEST_SALT);
  const authenticate = createMiddlewareAuth({
    username: "bruno",
    passwordHash,
  });
  const response = createResponse();
  let nextCalled = false;

  await authenticate(
    createRequest(basicHeader("bruno", "test-password")),
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(nextCalled, true);
});

test("leaves health and Swagger UI public while protecting the API", async (t) => {
  process.env.EWS_USER = "test-ews-user";
  process.env.EWS_PASSWORD = "test-ews-password";
  process.env.MIDDLEWARE_USER = "bruno";
  process.env.MIDDLEWARE_PASSWORD_HASH = createPasswordHash(
    "test-password",
    TEST_SALT
  );

  const { app } = require("../middleware/server");
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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok" });

  const apiResponse = await fetch(`${baseUrl}/api/info`);
  assert.equal(apiResponse.status, 401);
  assert.match(apiResponse.headers.get("www-authenticate"), /^Basic /);

  const docsResponse = await fetch(`${baseUrl}/api-docs/`);
  assert.equal(docsResponse.status, 200);
  assert.match(await docsResponse.text(), /Swagger UI/);
});
