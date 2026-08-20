const express = require("express");
const {
  asyncRoute,
  requireNonEmptyArray,
} = require("./routeUtils");

const MAX_WRITE_ITEMS = 100;

function validateWriteItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "items must be a non-empty array.";
  }

  if (items.length > MAX_WRITE_ITEMS) {
    return `items must contain no more than ${MAX_WRITE_ITEMS} entries.`;
  }

  for (const [index, item] of items.entries()) {
    const field = `items[${index}]`;

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `${field} must be an object.`;
    }

    if (typeof item.id !== "string" || item.id.trim() === "") {
      return `${field}.id must be a non-empty string.`;
    }

    if (!Object.hasOwn(item, "value")) {
      return `${field}.value is required.`;
    }

    const valueType = typeof item.value;
    const isSupportedType =
      valueType === "string" ||
      valueType === "boolean" ||
      (valueType === "number" && Number.isFinite(item.value));

    if (!isSupportedType) {
      return `${field}.value must be a string, finite number, or boolean.`;
    }
  }

  return null;
}

function createDataRouter(ews) {
  const router = express.Router();

  router.get("/values/test", async (req, res) => {
    try {
      const ids = [
        "01/ES/Test4EWS/Values/Analog Value",
        "01/ES/Test4EWS/Values/Digital Value",
        "01/ES/Test4EWS/Values/String Value",
        "01/ES/Test4EWS/Values/Time Stamp Value",
        "01/ES/Test4EWS/Values/access_token",
        "01/ES/Test4EWS/Values/Multistate Value",
      ];

      const result = await ews.getValues(ids);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error.message,
        body: error.body || null,
      });
    }
  });

  router.post("/values/read", async (req, res) => {
    try {
      const ids = req.body.ids;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          error: "Body must contain non-empty array: { ids: [...] }",
        });
      }

      const result = await ews.getValues(ids);
      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: error.message,
        body: error.body || null,
      });
    }
  });

  router.post(
    "/values/write",
    asyncRoute(async (req, res) => {
      const { items } = req.body || {};
      const validationError = validateWriteItems(items);

      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const result = await ews.setValues(items);
      return res.json(result);
    })
  );

  router.post("/items/read", async (req, res) => {
    try {
      const { ids, metadata = false } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          error: "ids must be a non-empty array",
        });
      }

      const result = await ews.getItems(ids, metadata);
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message,
        soapFault: error.soapFault || null,
      });
    }
  });

  router.post(
    "/enums/read",
    asyncRoute(async (req, res) => {
      const { ids } = req.body;

      requireNonEmptyArray(ids, "ids");

      const result = await ews.getEnums(ids);
      res.json(result);
    })
  );

  router.get(
    "/hierarchy",
    asyncRoute(async (req, res) => {
      const id = req.query.id;

      if (!id) {
        return res.status(400).json({
          error: "Query parameter 'id' is required.",
        });
      }

      const result = await ews.getHierarchicalInformation(id);
      return res.json(result);
    })
  );

  return router;
}

module.exports = {
  createDataRouter,
};
