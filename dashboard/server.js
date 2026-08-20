require("dotenv").config({ quiet: true });

const { createApp } = require("./app");
const { loadConfig } = require("./lib/config");
const { PointPoller } = require("./lib/pointPoller");

function createRuntime(env = process.env) {
  const config = loadConfig(env);
  const poller = new PointPoller({
    middlewareUrl: config.middlewareUrl,
    username: config.username,
    password: config.password,
    widgets: config.widgets,
    intervalMs: config.intervalMs,
    timeoutMs: config.timeoutMs,
    demoMode: config.demoMode,
  });
  const app = createApp({ poller, config });

  return { app, config, poller };
}

if (require.main === module) {
  const { app, config, poller } = createRuntime();
  let shuttingDown = false;
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`PLC dashboard listening on port ${config.port}`);
    poller.start();
  });

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    poller.stop();
    server.close(() => process.exit(0));

    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 1_000);
    forceCloseTimer.unref();
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = {
  createRuntime,
};
