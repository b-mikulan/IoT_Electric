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
          "Calls the EWS SOAP operation GetContainerItems. Leave id empty to get the root container. Known test containers include 00/ES/Test4EWS and 00/ES/Test4EWS/Values.",
        parameters: [
          {
            name: "id",
            in: "query",
            required: false,
            schema: {
              type: "string",
              example: "00/ES/Test4EWS/Values",
            },
            examples: {
              root: {
                summary: "Root container",
                value: "",
              },
              testFolder: {
                summary: "Test4EWS folder",
                value: "00/ES/Test4EWS",
              },
              valuesFolder: {
                summary: "Values folder",
                value: "00/ES/Test4EWS/Values",
              },
              alarmsFolder: {
                summary: "Alarms folder",
                value: "00/ES/Test4EWS/Alarms",
              },
              trendLogsFolder: {
                summary: "Trend Logs folder",
                value: "00/ES/Test4EWS/Trend Logs",
              },
            },
            description:
              "EWS container ID. If omitted or empty, the root container is requested.",
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
        summary: "Read known test datapoints",
        description:
          "Reads predefined test datapoints from 00/ES/Test4EWS/Values using the EWS GetValues SOAP operation. This is the easiest demo endpoint.",
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
                  },
                },
              },
              examples: {
                oneValue: {
                  summary: "Read Analog Value",
                  value: {
                    ids: [
                      "01/ES/Test4EWS/Values/Analog Value",
                    ],
                  },
                },
                multipleValues: {
                  summary: "Read multiple test values",
                  value: {
                    ids: [
                      "01/ES/Test4EWS/Values/Analog Value",
                      "01/ES/Test4EWS/Values/Digital Value",
                      "01/ES/Test4EWS/Values/String Value",
                      "01/ES/Test4EWS/Values/Time Stamp Value",
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

    "/api/items/read": {
      post: {
        summary: "Read items with optional metadata",
        description:
          "Calls the EWS SOAP operation GetItems for the provided item IDs. This returns item metadata/details, while GetValues returns actual current values.",
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
                  },
                  metadata: {
                    type: "boolean",
                    default: false,
                  },
                },
              },
              examples: {
                valueItems: {
                  summary: "Read known ValueItems",
                  value: {
                    ids: [
                      "01/ES/Test4EWS/Values/Analog Value",
                      "01/ES/Test4EWS/Values/Digital Value",
                    ],
                    metadata: false,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Items data",
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

    "/api/alarm-event-types": {
      get: {
        summary: "Get alarm event types",
        description:
          "Calls the EWS SOAP operation GetAlarmEventTypes. This request does not need input parameters.",
        responses: {
          200: {
            description: "Alarm event types",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },

    "/api/enums/read": {
      post: {
        summary: "Read enumerations",
        description:
          "Calls the EWS SOAP operation GetEnums for the provided enum IDs. The Digital Value test point uses ~/system.pt.Boolean.",
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
                  },
                },
              },
              examples: {
                booleanEnum: {
                  summary: "Read Boolean enum",
                  value: {
                    ids: [
                      "~/system.pt.Boolean",
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Enumeration values",
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

    "/api/hierarchy": {
      get: {
        summary: "Get hierarchical information",
        description:
          "Calls the EWS SOAP operation GetHierarchicalInformation for a known item ID.",
        parameters: [
          {
            name: "id",
            in: "query",
            required: true,
            schema: {
              type: "string",
              example: "01/ES/Test4EWS/Values/Analog Value",
            },
            examples: {
              analogValue: {
                summary: "Analog Value hierarchy",
                value: "01/ES/Test4EWS/Values/Analog Value",
              },
              valuesFolder: {
                summary: "Values folder hierarchy",
                value: "00/ES/Test4EWS/Values",
              },
            },
            description: "Item ID for hierarchical information.",
          },
        ],
        responses: {
          200: {
            description: "Hierarchical information",
          },
          400: {
            description: "Missing required parameter",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },

    "/api/alarms/query": {
      post: {
        summary: "Query active alarm events",
        description:
          "Calls the EWS SOAP operation GetAlarmEvents. Empty body should be valid and may return an empty list if there are no active alarms.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  moreDataRef: {
                    type: "string",
                  },
                  priorityFrom: {
                    type: "integer",
                  },
                  priorityTo: {
                    type: "integer",
                  },
                  types: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                    default: [],
                  },
                  metadata: {
                    type: "boolean",
                    default: false,
                  },
                },
              },
              examples: {
                noFilter: {
                  summary: "No filter",
                  value: {},
                },
                priorityFilter: {
                  summary: "Priority range",
                  value: {
                    priorityFrom: 1,
                    priorityTo: 255,
                    types: [],
                    metadata: false,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Alarm events",
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

    "/api/history/query": {
      post: {
        summary: "Query historical data",
        description:
          "Calls the EWS SOAP operation GetHistory. You must first discover a real HistoryItem ID, for example by calling /api/containers?id=00/ES/Test4EWS/Trend Logs.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["historyItemId"],
                properties: {
                  historyItemId: {
                    type: "string",
                  },
                  timeFrom: {
                    type: "string",
                    format: "date-time",
                  },
                  timeTo: {
                    type: "string",
                    format: "date-time",
                  },
                  moreDataRef: {
                    type: "string",
                  },
                  metadata: {
                    type: "boolean",
                    default: false,
                  },
                },
              },
              examples: {
                needsRealHistoryItemId: {
                  summary: "Replace with discovered HistoryItem ID",
                  value: {
                    historyItemId: "REPLACE_WITH_HISTORY_ITEM_ID_FROM_TREND_LOGS",
                    timeFrom: "2026-07-01T00:00:00Z",
                    timeTo: "2026-07-08T00:00:00Z",
                    metadata: false,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Historical data",
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

    "/api/alarm-history/query": {
      post: {
        summary: "Query alarm history",
        description:
          "Calls the EWS SOAP operation GetAlarmHistory. You can try an empty body first. For a specific alarm item, discover AlarmItem IDs from /api/containers?id=00/ES/Test4EWS/Alarms.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  alarmItemId: {
                    type: "string",
                  },
                  moreDataRef: {
                    type: "string",
                  },
                  timeFrom: {
                    type: "string",
                    format: "date-time",
                  },
                  timeTo: {
                    type: "string",
                    format: "date-time",
                  },
                  priorityFrom: {
                    type: "integer",
                  },
                  priorityTo: {
                    type: "integer",
                  },
                  types: {
                    type: "array",
                    items: {
                      type: "string",
                    },
                    default: [],
                  },
                  metadata: {
                    type: "boolean",
                    default: false,
                  },
                },
              },
              examples: {
                noFilter: {
                  summary: "No filter",
                  value: {},
                },
                withDateRange: {
                  summary: "Date range",
                  value: {
                    timeFrom: "2026-07-01T00:00:00Z",
                    timeTo: "2026-07-08T00:00:00Z",
                    priorityFrom: 1,
                    priorityTo: 255,
                    types: [],
                    metadata: false,
                  },
                },
                needsRealAlarmItemId: {
                  summary: "Replace with discovered AlarmItem ID",
                  value: {
                    alarmItemId: "REPLACE_WITH_ALARM_ITEM_ID_FROM_ALARMS_FOLDER",
                    timeFrom: "2026-07-01T00:00:00Z",
                    timeTo: "2026-07-08T00:00:00Z",
                    metadata: false,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Alarm history",
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

    "/api/subscriptions": {
      post: {
        summary: "Create subscription",
        description:
          "Calls the EWS SOAP operation Subscribe. The safest test is subscribing to Analog Value change events with eventType 0 and eventMode 0.",
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
                  },
                  eventType: {
                    type: "integer",
                    enum: [0, 1, 2, 3],
                    default: 0,
                    description:
                      "0 = ValueItemChanged, 1 = AlarmEventCreated, 2 = SystemEventCreated, 3 = HierarchyChanged",
                  },
                  eventMode: {
                    type: "integer",
                    enum: [0, 1],
                    default: 0,
                    description:
                      "0 = exact item IDs, 1 = container and first-level children",
                  },
                  expires: {
                    type: "string",
                    default: "PT30M",
                  },
                  notifyToAddress: {
                    type: "string",
                    default: "",
                  },
                  metadata: {
                    type: "boolean",
                    default: false,
                  },
                },
              },
              examples: {
                analogValueSubscription: {
                  summary: "Subscribe to Analog Value changes",
                  value: {
                    ids: [
                      "01/ES/Test4EWS/Values/Analog Value",
                    ],
                    eventType: 0,
                    eventMode: 0,
                    expires: "PT30M",
                    notifyToAddress: "",
                    metadata: false,
                  },
                },
                valuesFolderSubscription: {
                  summary: "Subscribe to Values folder children",
                  value: {
                    ids: [
                      "00/ES/Test4EWS/Values",
                    ],
                    eventType: 0,
                    eventMode: 1,
                    expires: "PT30M",
                    notifyToAddress: "",
                    metadata: false,
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Subscription created",
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

    "/api/subscriptions/{subscriptionId}/notifications": {
      post: {
        summary: "Get subscription notifications",
        description:
          "Calls the EWS SOAP operation GetNotification. First call it with an empty JSON body, then reuse NotificationId and MoreDataRef returned by the server if needed.",
        parameters: [
          {
            name: "subscriptionId",
            in: "path",
            required: true,
            schema: {
              type: "string",
              example: "REPLACE_WITH_SUBSCRIPTION_ID",
            },
            description: "Subscription ID returned by POST /api/subscriptions.",
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  notificationId: {
                    type: "string",
                  },
                  moreDataRef: {
                    type: "string",
                  },
                },
              },
              examples: {
                firstCall: {
                  summary: "First notification call",
                  value: {},
                },
                nextCall: {
                  summary: "Next notification call",
                  value: {
                    notificationId: "REPLACE_WITH_NOTIFICATION_ID",
                  },
                },
                pagingCall: {
                  summary: "Paging call",
                  value: {
                    notificationId: "REPLACE_WITH_NOTIFICATION_ID",
                    moreDataRef: "REPLACE_WITH_MORE_DATA_REF",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Notifications",
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

    "/api/subscriptions/{subscriptionId}/renew": {
      post: {
        summary: "Renew subscription",
        description:
          "Calls the EWS SOAP operation Renew. Use the SubscriptionId returned by POST /api/subscriptions.",
        parameters: [
          {
            name: "subscriptionId",
            in: "path",
            required: true,
            schema: {
              type: "string",
              example: "REPLACE_WITH_SUBSCRIPTION_ID",
            },
            description: "Subscription ID",
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  expires: {
                    type: "string",
                    default: "PT30M",
                  },
                },
              },
              examples: {
                thirtyMinutes: {
                  summary: "Renew for 30 minutes",
                  value: {
                    expires: "PT30M",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Subscription renewed",
          },
          500: {
            description: "Server or EWS communication error",
          },
        },
      },
    },

    "/api/subscriptions/{subscriptionId}": {
      delete: {
        summary: "Unsubscribe",
        description:
          "Calls the EWS SOAP operation Unsubscribe. Use this to clean up a test subscription.",
        parameters: [
          {
            name: "subscriptionId",
            in: "path",
            required: true,
            schema: {
              type: "string",
              example: "REPLACE_WITH_SUBSCRIPTION_ID",
            },
            description: "Subscription ID",
          },
        ],
        responses: {
          200: {
            description: "Unsubscribed successfully",
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