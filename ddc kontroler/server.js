const express = require("express");
const swaggerUi = require("swagger-ui-express");
const { createEwsClient } = require("./ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const ews = createEwsClient();

const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "EcoStruxure EWS REST Wrapper",
    version: "0.1.0",
    description:
      "Simple Node/Express REST wrapper around Schneider EcoStruxure Web Services SOAP API.",
  },
  servers: [
    {
      url: `http://localhost:${port}`,
      description: "Local development server",
    },
  ],
  paths: {
    "/api/info": {
      get: {
        summary: "Get EWS service information",
        description:
          "Calls the EWS SOAP operation GetWebServiceInformation and returns service metadata as JSON.",
        responses: {
          200: {
            description: "EWS service information",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },

    "/api/containers": {
      get: {
        summary: "Get container items",
        description:
          "Calls the EWS SOAP operation GetContainerItems. Use an empty id to get the root container.",
        parameters: [
          {
            name: "id",
            in: "query",
            required: false,
            schema: {
              type: "string",
              example: "00/ES/Test4EWS/Values",
            },
            description:
              "EWS container ID. If omitted, the root container is requested.",
          },
        ],
        responses: {
          200: {
            description: "Container items returned as JSON",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },

    "/api/values/test": {
      get: {
        summary: "Read test datapoints",
        description:
          "Reads predefined test datapoints from 00/ES/Test4EWS/Values using the EWS GetValues SOAP operation.",
        responses: {
          200: {
            description: "Test datapoint values",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },

    "/api/values/read": {
      post: {
        summary: "Read one or more datapoint values",
        description:
          "Calls the EWS SOAP operation GetValues for the provided ValueItem IDs.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ids"],
                properties: {
                  ids: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                    example: [
                      "01/ES/Test4EWS/Values/Analog Value",
                      "01/ES/Test4EWS/Values/Digital Value",
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Datapoint values",
          },
          400: {
            description: "Invalid request body",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },
  },
};

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

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

app.listen(port, () => {
  console.log(`REST wrapper running on http://localhost:${port}`);
  console.log(`Swagger UI available at http://localhost:${port}/api-docs`);
});