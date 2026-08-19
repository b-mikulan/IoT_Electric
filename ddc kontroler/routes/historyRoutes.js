const express = require("express");
const { asyncRoute } = require("./routeUtils");

function createHistoryRouter(ews) {
  const router = express.Router();

  router.post(
    "/history/query",
    asyncRoute(async (req, res) => {
      const {
        historyItemId,
        timeFrom,
        timeTo,
        moreDataRef,
        metadata = false,
      } = req.body;

      if (!historyItemId) {
        return res.status(400).json({
          error: "historyItemId is required.",
        });
      }

      const result = await ews.getHistory({
        historyItemId,
        timeFrom,
        timeTo,
        moreDataRef,
        metadata,
      });

      return res.json(result);
    })
  );

  return router;
}

module.exports = {
  createHistoryRouter,
};
