const express = require("express");
const { createAlarmRouter } = require("./alarmRoutes");
const { createCoreRouter } = require("./coreRoutes");
const { createDataRouter } = require("./dataRoutes");
const { createHistoryRouter } = require("./historyRoutes");
const { createSubscriptionRouter } = require("./subscriptionRoutes");

function createApiRouter(ews) {
  if (!ews) {
    throw new Error("An EWS client is required to create the API router.");
  }

  const router = express.Router();

  router.use(createCoreRouter(ews));
  router.use(createDataRouter(ews));
  router.use(createAlarmRouter(ews));
  router.use(createHistoryRouter(ews));
  router.use(createSubscriptionRouter(ews));

  return router;
}

module.exports = {
  createApiRouter,
};
