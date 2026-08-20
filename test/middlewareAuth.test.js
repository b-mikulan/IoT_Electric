const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMiddlewareAuth,
  createPasswordHash,
  parseBasicAuthorization,
  verifyPassword,
} = require("../middleware/middlewareAuth");

const TEST_SALT = "00112233445566778899aabbccddeeff";

function basicHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function createRequest(authorization) {
  return {
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

test("creates and verifies a scrypt password hash", () => {
  const hash = createPasswordHash("test-password", TEST_SALT);

  assert.equal(verifyPassword("test-password", hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
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

test("rejects incorrect credentials", () => {
  const passwordHash = createPasswordHash("test-password", TEST_SALT);
  const authenticate = createMiddlewareAuth({
    username: "bruno",
    passwordHash,
  });
  const response = createResponse();
  let nextCalled = false;

  authenticate(
    createRequest(basicHeader("bruno", "wrong-password")),
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("allows correct credentials", () => {
  const passwordHash = createPasswordHash("test-password", TEST_SALT);
  const authenticate = createMiddlewareAuth({
    username: "bruno",
    passwordHash,
  });
  const response = createResponse();
  let nextCalled = false;

  authenticate(
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
