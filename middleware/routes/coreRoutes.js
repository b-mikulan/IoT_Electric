const express = require("express");
const { asyncRoute } = require("./routeUtils");

function queryString(value, name, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  throw Object.assign(new Error(`${name} must be a single string.`), { status: 400 });
}

function queryBoolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw Object.assign(new Error(`${name} must be true or false.`), { status: 400 });
}

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

  router.get("/containers", asyncRoute(async (req, res) => {
    const id = queryString(req.query.id, "id");
    const options = {
      metadata: queryBoolean(req.query.metadata, "metadata", false),
      moreDataRef: queryString(req.query.moreDataRef, "moreDataRef"),
      allPages: queryBoolean(req.query.allPages, "allPages", true),
    };
    res.json(await ews.getContainerItems(id, options));
  }));

  return router;
}

module.exports = {
  createCoreRouter,
};
