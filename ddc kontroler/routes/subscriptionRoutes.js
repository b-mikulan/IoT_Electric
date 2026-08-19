const express = require("express");
const {
  asyncRoute,
  requireNonEmptyArray,
} = require("./routeUtils");

function createSubscriptionRouter(ews) {
  const router = express.Router();

  router.post(
    "/subscriptions",
    asyncRoute(async (req, res) => {
      const {
        ids,
        eventType = 0,
        eventMode = 0,
        expires = "PT30M",
        notifyToAddress = "",
        metadata = false,
      } = req.body;

      requireNonEmptyArray(ids, "ids");

      if (![0, 1, 2, 3].includes(Number(eventType))) {
        return res.status(400).json({
          error: "eventType must be 0, 1, 2 or 3.",
        });
      }

      if (![0, 1].includes(Number(eventMode))) {
        return res.status(400).json({
          error: "eventMode must be 0 or 1.",
        });
      }

      const result = await ews.subscribe({
        ids,
        eventType: Number(eventType),
        eventMode: Number(eventMode),
        expires,
        notifyToAddress,
        metadata,
      });

      return res.status(201).json(result);
    })
  );

  router.post(
    "/subscriptions/:subscriptionId/notifications",
    asyncRoute(async (req, res) => {
      const { subscriptionId } = req.params;
      const { notificationId, moreDataRef } = req.body || {};

      const result = await ews.getNotification({
        subscriptionId,
        notificationId,
        moreDataRef,
      });

      res.json(result);
    })
  );

  router.post(
    "/subscriptions/:subscriptionId/renew",
    asyncRoute(async (req, res) => {
      const { subscriptionId } = req.params;
      const { expires = "PT30M" } = req.body || {};

      const result = await ews.renew(subscriptionId, expires);
      res.json(result);
    })
  );

  router.delete(
    "/subscriptions/:subscriptionId",
    asyncRoute(async (req, res) => {
      const { subscriptionId } = req.params;

      const result = await ews.unsubscribe(subscriptionId);
      res.json(result);
    })
  );

  return router;
}

module.exports = {
  createSubscriptionRouter,
};
