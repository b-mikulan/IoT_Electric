const express = require("express");
const { asyncRoute } = require("./routeUtils");

function createAlarmRouter(ews) {
  const router = express.Router();

  router.get(
    "/alarm-event-types",
    asyncRoute(async (req, res) => {
      const result = await ews.getAlarmEventTypes();
      res.json(result);
    })
  );

  router.post(
    "/alarms/query",
    asyncRoute(async (req, res) => {
      const {
        moreDataRef,
        priorityFrom,
        priorityTo,
        types = [],
        metadata = false,
      } = req.body || {};

      if (!Array.isArray(types)) {
        return res.status(400).json({
          error: "types must be an array.",
        });
      }

      const result = await ews.getAlarmEvents({
        moreDataRef,
        priorityFrom,
        priorityTo,
        types,
        metadata,
      });

      return res.json(result);
    })
  );

  router.post(
    "/alarm-history/query",
    asyncRoute(async (req, res) => {
      const {
        alarmItemId,
        moreDataRef,
        timeFrom,
        timeTo,
        priorityFrom,
        priorityTo,
        types = [],
        metadata = false,
      } = req.body || {};

      if (!Array.isArray(types)) {
        return res.status(400).json({
          error: "types must be an array.",
        });
      }

      const result = await ews.getAlarmHistory({
        alarmItemId,
        moreDataRef,
        timeFrom,
        timeTo,
        priorityFrom,
        priorityTo,
        types,
        metadata,
      });

      return res.json(result);
    })
  );

  return router;
}

module.exports = {
  createAlarmRouter,
};
