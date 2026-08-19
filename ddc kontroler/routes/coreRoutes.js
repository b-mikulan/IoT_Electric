const express = require("express");

function createCoreRouter(ews) {
  const router = express.Router();

  router.get("/info", async (req, res) => {
    try {
      const info = await ews.getWebServiceInformation();
      res.json(info);
    } catch (error) {
      res.status(500).json({
        error: error.message,
        body: error.body || null,
      });
    }
  });

  router.get("/containers", async (req, res) => {
    try {
      const id = req.query.id || "";
      const result = await ews.getContainerItems(id);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error.message,
        body: error.body || null,
      });
    }
  });

  return router;
}

module.exports = {
  createCoreRouter,
};
