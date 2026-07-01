const express = require("express");
const { createEwsClient } = require("./ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const ews = createEwsClient();

app.get("/api/info", async (req, res) => {
  try {
    const info = await ews.getWebServiceInformation();
    res.json(info);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      body: err.body || null,
    });
  }
});

app.get("/api/containers", async (req, res) => {
  try {
    const id = req.query.id || "";
    const result = await ews.getContainerItems(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      body: err.body || null,
    });
  }
});

app.post("/api/values/read", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: "Body must contain non-empty array: { ids: [...] }",
      });
    }

    const result = await ews.getValues(ids);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      body: err.body || null,
    });
  }
});

app.get("/api/values/test", async (req, res) => {
  try {
    const ids = [
      "01/ES/Test4EWS/Values/Analog Value",
      "01/ES/Test4EWS/Values/Digital Value",
      "01/ES/Test4EWS/Values/String Value",
      "01/ES/Test4EWS/Values/Time Stamp Value",
    ];

    const result = await ews.getValues(ids);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      body: err.body || null,
    });
  }
});

app.listen(port, () => {
  console.log(`REST wrapper running on http://localhost:${port}`);
});