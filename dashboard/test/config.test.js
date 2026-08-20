const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, parseWidgets } = require("../lib/config");

test("uses a clearly marked zero-configuration demo by default", () => {
  const config = loadConfig({});

  assert.equal(config.demoMode, true);
  assert.equal(config.port, 3001);
  assert.equal(config.intervalMs, 15_000);
  assert.equal(config.timeoutMs, 10_000);
  assert.equal(config.widgets.length, 3);
});

test("parses real widget configuration and requires client credentials", () => {
  const widgets = JSON.stringify([
    {
      id: "01/ES/Office/Temperature",
      label: "Temperatura",
      unit: "°C",
      precision: 1,
    },
  ]);

  assert.throws(
    () => loadConfig({ DEMO_MODE: "false", WIDGETS_JSON: widgets }),
    /MIDDLEWARE_USER and either MIDDLEWARE_PASSWORD/
  );

  const config = loadConfig({
    DEMO_MODE: "false",
    MIDDLEWARE_URL: "http://middleware:3000/",
    MIDDLEWARE_USER: "client",
    MIDDLEWARE_PASSWORD: "secret",
    WIDGETS_JSON: widgets,
  });

  assert.equal(config.demoMode, false);
  assert.equal(config.middlewareUrl, "http://middleware:3000");
  assert.equal(config.widgets[0].precision, 1);
});

test("rejects duplicate point identifiers", () => {
  assert.throws(
    () => parseWidgets('[{"id":"same"},{"id":"same"}]', false),
    /duplicate id: same/
  );
});
