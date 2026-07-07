const express = require("express");
const swaggerUi = require("swagger-ui-express");
const { createEwsClient } = require("./ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const ews = createEwsClient();

function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireNonEmptyArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    const error = new Error(`${fieldName} must be a non-empty array.`);
    error.status = 400;
    throw error;
  }
}

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

app.post("/api/items/read", async (req, res) => {
  try {
    const { ids, metadata = false } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: "ids must be a non-empty array",
      });
    }

    const result = await ews.getItems(ids, metadata);

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      soapFault: error.soapFault || null,
    });
  }
});

app.get(
  "/api/alarm-event-types",
  asyncRoute(async (req, res) => {
    const result = await ews.getAlarmEventTypes();

    res.json(result);
  })
);


app.post(
  "/api/enums/read",
  asyncRoute(async (req, res) => {
    const { ids } = req.body;

    requireNonEmptyArray(ids, "ids");

    const result = await ews.getEnums(ids);

    res.json(result);
  })
);

app.get(
  "/api/hierarchy",
  asyncRoute(async (req, res) => {
    const id = req.query.id;

    if (!id) {
      return res.status(400).json({
        error: "Query parameter 'id' is required.",
      });
    }

    const result = await ews.getHierarchicalInformation(id);

    res.json(result);
  })
);

app.post(
  "/api/alarms/query",
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

    res.json(result);
  })
);


app.post(
  "/api/history/query",
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

    res.json(result);
  })
);

app.post(
  "/api/alarm-history/query",
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

    res.json(result);
  })
);

app.post(
  "/api/subscriptions",
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

    res.status(201).json(result);
  })
);


app.post(
  "/api/subscriptions/:subscriptionId/notifications",
  asyncRoute(async (req, res) => {
    const { subscriptionId } = req.params;
    const {
      notificationId,
      moreDataRef,
    } = req.body || {};

    const result = await ews.getNotification({
      subscriptionId,
      notificationId,
      moreDataRef,
    });

    res.json(result);
  })
);

app.post(
  "/api/subscriptions/:subscriptionId/renew",
  asyncRoute(async (req, res) => {
    const { subscriptionId } = req.params;
    const { expires = "PT30M" } = req.body || {};

    const result = await ews.renew(
      subscriptionId,
      expires
    );

    res.json(result);
  })
);

app.delete(
  "/api/subscriptions/:subscriptionId",
  asyncRoute(async (req, res) => {
    const { subscriptionId } = req.params;

    const result = await ews.unsubscribe(subscriptionId);

    res.json(result);
  })
);

app.use((error, req, res, next) => {
  console.error(error);

  res.status(error.status || 500).json({
    error: error.message,
    soapFault: error.soapFault || null,

    // Za razvoj je korisno, ali nemoj izlagati raw XML u produkciji.
    rawResponse:
      process.env.NODE_ENV === "development"
        ? error.body || null
        : undefined,
  });
});


app.listen(port, () => {
  console.log(`REST wrapper running on http://localhost:${port}`);
  console.log(`Swagger UI available at http://localhost:${port}/api-docs`);
});