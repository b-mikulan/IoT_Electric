const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "EcoStruxure EWS REST Wrapper",
    version: "0.3.0",
    description:
      "Simple Node/Express REST wrapper around Schneider EcoStruxure Web Services SOAP API.",
  },
  servers: [
    {
      url: `/`,
      description: "Current server",
    },
  ],
  components: {
    securitySchemes: {
      MiddlewareAuth: {
        type: "http",
        scheme: "basic",
        description: "Middleware username and password. These are separate from the EWS controller credentials.",
      },
    },
  },
  security: [{ MiddlewareAuth: [] }],
  paths: {
    "/health": {
      get: {
        summary: "Check middleware health",
        security: [],
        responses: {
          200: {
            description: "Middleware process is running",
          },
        },
      },
    },
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
                      "01/ES/Test4EWS/Values/Multistate Value",
                      "01/ES/Test4EWS/Values/access_token"
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

    "/api/values/write": {
      post: {
        summary: "Write one or more datapoint values",
        description:
          "Calls the EWS SOAP operation SetValues for the provided ValueItems. Each item must contain a writable datapoint ID and a scalar value. A successful HTTP response can still contain success: false when the controller rejects an individual write.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    minItems: 1,
                    maxItems: 100,
                    items: {
                      type: "object",
                      required: ["id", "value"],
                      properties: {
                        id: {
                          type: "string",
                          minLength: 1,
                          pattern: "\\S",
                        },
                        value: {
                          oneOf: [
                            { type: "string" },
                            { type: "number" },
                            { type: "boolean" },
                          ],
                        },
                      },
                    },
                  },
                },
              },
              examples: {
                analogValue: {
                  summary: "Set Analog Value",
                  value: {
                    items: [
                      {
                        id: "01/ES/Test4EWS/Values/Analog Value",
                        value: 69,
                      },
                    ],
                  },
                },
                multipleValues: {
                  summary: "Set multiple values",
                  value: {
                    items: [
                      {
                        id: "01/ES/Test4EWS/Values/Analog Value",
                        value: 69,
                      },
                      {
                        id: "01/ES/Test4EWS/Values/Digital Value",
                        value: true,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Per-datapoint write results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["results"],
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["id", "success", "message"],
                        properties: {
                          id: { type: "string" },
                          success: { type: "boolean" },
                          message: { type: "string" },
                        },
                      },
                    },
                  },
                },
                example: {
                  results: [
                    {
                      id: "01/ES/Test4EWS/Values/Analog Value",
                      success: true,
                      message: "",
                    },
                  ],
                },
              },
            },
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
                  summary: "HistoryItem ID",
                  value: {
                    historyItemId: "03/ES/Test4EWS/Trend Logs/Multistate Value Interval Trend Log",
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
                  summary: "AlarmItem ID",
                  value: {
                    alarmItemId: "02/ES/Test4EWS/Alarms/Change of State Alarm",
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

module.exports = swaggerDocument;
