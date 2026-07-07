const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");

const DEFAULT_SERVICE_URL =
  "https://bms.iot-electric.hr/EcoStruxure/DataExchange";

const EWS_NAMESPACE =
  "http://www.schneider-electric.com/common/dataexchange/2011/05";

const SOAP_ACTIONS = Object.freeze({
  GET_WEB_SERVICE_INFORMATION:
    `${EWS_NAMESPACE}/GetWebServiceInformationIn`,
  GET_CONTAINER_ITEMS:
    `${EWS_NAMESPACE}/GetContainerItemsIn`,
  GET_ITEMS:
    `${EWS_NAMESPACE}/GetItemsIn`,
  GET_VALUES:
    `${EWS_NAMESPACE}/GetValuesIn`,
  SET_VALUES:
    `${EWS_NAMESPACE}/SetValuesIn`,

  GET_ALARM_EVENTS:
    `${EWS_NAMESPACE}/GetAlarmEventsIn`,
  GET_UPDATED_ALARM_EVENTS:
    `${EWS_NAMESPACE}/GetUpdatedAlarmEventsIn`,
  GET_ALARM_EVENT_TYPES:
    `${EWS_NAMESPACE}/GetAlarmEventTypesIn`,
  ACKNOWLEDGE_ALARM_EVENTS:
    `${EWS_NAMESPACE}/AcknowledgeAlarmEventsIn`,

  GET_HISTORY:
    `${EWS_NAMESPACE}/GetHistoryIn`,
  GET_ALARM_HISTORY:
    `${EWS_NAMESPACE}/GetAlarmHistoryIn`,

  FORCE_VALUES:
    `${EWS_NAMESPACE}/ForceValuesIn`,
  UNFORCE_VALUES:
    `${EWS_NAMESPACE}/UnforceValuesIn`,

  GET_ENUMS:
    `${EWS_NAMESPACE}/GetEnumsIn`,
  GET_HIERARCHICAL_INFORMATION:
    `${EWS_NAMESPACE}/GetHierarchicalInformationIn`,

  SUBSCRIBE:
    `${EWS_NAMESPACE}/SubscribeIn`,
  GET_NOTIFICATION:
    `${EWS_NAMESPACE}/GetNotificationIn`,
  RENEW:
    `${EWS_NAMESPACE}/RenewIn`,
  UNSUBSCRIBE:
    `${EWS_NAMESPACE}/UnsubscribeIn`,
});

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

function assertCredentials(username, password) {
  if (!username || !password) {
    throw new Error(
      "Missing credentials. Set EWS_USER and EWS_PASSWORD environment variables."
    );
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseDigestChallenge(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) {
    throw new Error("Missing WWW-Authenticate header");
  }

  const digestIndex = wwwAuthenticateHeader.toLowerCase().indexOf("digest ");
  if (digestIndex === -1) {
    throw new Error(
      `Server did not return Digest auth challenge: ${wwwAuthenticateHeader}`
    );
  }

  const challenge = wwwAuthenticateHeader.slice(
    digestIndex + "digest ".length
  );

  const params = {};
  const regex = /(\w+)=("([^"]*)"|([^,]*))/g;

  let match;
  while ((match = regex.exec(challenge)) !== null) {
    params[match[1]] = match[3] ?? match[4];
  }

  return params;
}

function hash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
}

function resolveHashAlgorithm(algorithmFromServer) {
  const alg = (algorithmFromServer || "MD5").toUpperCase();

  if (alg.includes("SHA-256")) return "sha256";
  if (alg.includes("MD5")) return "md5";

  throw new Error(`Unsupported digest algorithm: ${algorithmFromServer}`);
}

function getRequestUri(url) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function buildDigestAuthorizationHeader({
  method,
  url,
  body,
  challenge,
  username,
  password,
}) {
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const opaque = challenge.opaque;
  const algorithmRaw = challenge.algorithm || "MD5";
  const hashAlgorithm = resolveHashAlgorithm(algorithmRaw);

  const uri = getRequestUri(url);
  const nc = "00000001";
  const cnonce = crypto.randomBytes(16).toString("hex");

  const qopOptions = challenge.qop
    ? challenge.qop.split(",").map((x) => x.trim())
    : [];

  const qop = qopOptions.includes("auth") ? "auth" : undefined;

  if (!realm || !nonce) {
    throw new Error(`Invalid Digest challenge: ${JSON.stringify(challenge)}`);
  }

  let ha1 = hash(hashAlgorithm, `${username}:${realm}:${password}`);

  if (algorithmRaw.toUpperCase().endsWith("-SESS")) {
    ha1 = hash(hashAlgorithm, `${ha1}:${nonce}:${cnonce}`);
  }

  let ha2;

  if (qop === "auth-int") {
    const bodyHash = hash(hashAlgorithm, body || "");
    ha2 = hash(hashAlgorithm, `${method}:${uri}:${bodyHash}`);
  } else {
    ha2 = hash(hashAlgorithm, `${method}:${uri}`);
  }

  const response = qop
    ? hash(hashAlgorithm, `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(hashAlgorithm, `${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithmRaw}`,
    `response="${response}"`,
  ];

  if (opaque) {
    parts.push(`opaque="${opaque}"`);
  }

  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }

  return `Digest ${parts.join(", ")}`;
}

async function digestFetch(url, options, auth) {
  const method = options.method || "GET";
  const body = options.body || "";

  const firstResponse = await fetch(url, options);

  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  const wwwAuthenticate = firstResponse.headers.get("www-authenticate");
  const challenge = parseDigestChallenge(wwwAuthenticate);

  const authorization = buildDigestAuthorizationHeader({
    method,
    url,
    body,
    challenge,
    username: auth.username,
    password: auth.password,
  });

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: authorization,
    },
  });
}

function buildSoapEnvelope(innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header/>
  <s:Body>
    ${innerXml}
  </s:Body>
</s:Envelope>`;
}

function buildGetWebServiceInformationBody() {
  return buildSoapEnvelope(`
<GetWebServiceInformationRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2" />`);
}

function buildGetContainerItemsBody(containerId) {
  return buildSoapEnvelope(`
<GetContainerItemsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <GetContainerItemsIds>
    <Id>${escapeXml(containerId)}</Id>
  </GetContainerItemsIds>
</GetContainerItemsRequest>`);
}

function buildGetAlarmEventsBody({
  moreDataRef,
  priorityFrom,
  priorityTo,
  types = [],
  metadata = false,
} = {}) {
  const typesXml =
    types.length > 0
      ? `<Types>${types
          .map((type) => `<Type>${escapeXml(type)}</Type>`)
          .join("")}</Types>`
      : "";

  return buildSoapEnvelope(`
<GetAlarmEventsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  metadata="${metadata}">
  <GetAlarmEventsParameter>
    ${moreDataRef ? `<MoreDataRef>${escapeXml(moreDataRef)}</MoreDataRef>` : ""}
  </GetAlarmEventsParameter>
  <GetAlarmEventsFilter>
    ${
      priorityFrom !== undefined
        ? `<PriorityFrom>${priorityFrom}</PriorityFrom>`
        : ""
    }
    ${
      priorityTo !== undefined
        ? `<PriorityTo>${priorityTo}</PriorityTo>`
        : ""
    }
    ${typesXml}
  </GetAlarmEventsFilter>
</GetAlarmEventsRequest>`);
}

function buildGetUpdatedAlarmEventsBody({
  lastUpdate,
  moreDataRef,
  priorityFrom,
  priorityTo,
  types = [],
  metadata = false,
}) {
  if (!lastUpdate) {
    throw new Error("lastUpdate is required.");
  }

  const typesXml =
    types.length > 0
      ? `<Types>${types
          .map((type) => `<Type>${escapeXml(type)}</Type>`)
          .join("")}</Types>`
      : "";

  return buildSoapEnvelope(`
<GetUpdatedAlarmEventsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  metadata="${metadata}">
  <GetUpdatedAlarmEventsParameter>
    <LastUpdate>${escapeXml(lastUpdate)}</LastUpdate>
    ${moreDataRef ? `<MoreDataRef>${escapeXml(moreDataRef)}</MoreDataRef>` : ""}
  </GetUpdatedAlarmEventsParameter>
  <GetUpdatedAlarmEventsFilter>
    ${
      priorityFrom !== undefined
        ? `<PriorityFrom>${priorityFrom}</PriorityFrom>`
        : ""
    }
    ${
      priorityTo !== undefined
        ? `<PriorityTo>${priorityTo}</PriorityTo>`
        : ""
    }
    ${typesXml}
  </GetUpdatedAlarmEventsFilter>
</GetUpdatedAlarmEventsRequest>`);
}

function buildGetAlarmEventTypesBody() {
  return buildSoapEnvelope(`
<GetAlarmEventTypesRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2" />`);
}

function buildAcknowledgeAlarmEventsBody(eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw new Error("eventIds must be a non-empty array.");
  }

  const idsXml = eventIds
    .map((id) => `<Id>${escapeXml(id)}</Id>`)
    .join("\n");

  return buildSoapEnvelope(`
<AcknowledgeAlarmEventsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <AcknowledgeAlarmEventsIds>
    ${idsXml}
  </AcknowledgeAlarmEventsIds>
</AcknowledgeAlarmEventsRequest>`);
}

function buildGetHistoryBody({
  historyItemId,
  timeFrom,
  timeTo,
  moreDataRef,
  metadata = false,
}) {
  return buildSoapEnvelope(`
<GetHistoryRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  metadata="${metadata}">
  <GetHistoryParameter>
    <Id>${escapeXml(historyItemId)}</Id>
    ${moreDataRef ? `<MoreDataRef>${escapeXml(moreDataRef)}</MoreDataRef>` : ""}
  </GetHistoryParameter>
  <GetHistoryFilter>
    ${timeFrom ? `<TimeFrom>${escapeXml(timeFrom)}</TimeFrom>` : ""}
    ${timeTo ? `<TimeTo>${escapeXml(timeTo)}</TimeTo>` : ""}
  </GetHistoryFilter>
</GetHistoryRequest>`);
}

function buildForceValuesBody(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("buildForceValuesBody expects a non-empty array of items.");
  }

  const itemXml = items
    .map(
      (item) => `<ValueItem>
  <Id>${escapeXml(item.id)}</Id>
  <Value>${escapeXml(item.value)}</Value>
</ValueItem>`
    )
    .join("\n");

  return buildSoapEnvelope(`
<ForceValuesRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <ForceValuesItems>
    ${itemXml}
  </ForceValuesItems>
</ForceValuesRequest>`);
}

function buildUnforceValuesBody(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("buildUnforceValuesBody expects a non-empty array of ids.");
  }

  const idXml = ids.map((id) => `<Id>${escapeXml(id)}</Id>`).join("\n");

  return buildSoapEnvelope(`
<UnforceValuesRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <UnforceValuesIds>
    ${idXml}
  </UnforceValuesIds>
</UnforceValuesRequest>`);
}

function buildGetEnumsBody(enumIds) {
  const ids = Array.isArray(enumIds) ? enumIds : [enumIds];

  if (ids.length === 0) {
    throw new Error("enumIds must not be empty.");
  }

  const idsXml = ids
    .map((id) => `<Id>${escapeXml(id)}</Id>`)
    .join("\n");

  return buildSoapEnvelope(`
<GetEnumsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <GetEnumIds>
    ${idsXml}
  </GetEnumIds>
</GetEnumsRequest>`);
}

function buildGetHierarchicalInformationBody(itemId) {
  return buildSoapEnvelope(`
<GetHierarchicalInformationRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <GetHierarchicalInformationId>${escapeXml(itemId)}</GetHierarchicalInformationId>
</GetHierarchicalInformationRequest>`);
}

function buildGetAlarmHistoryBody({
  alarmItemId,
  moreDataRef,
  timeFrom,
  timeTo,
  priorityFrom,
  priorityTo,
  types = [],
  metadata = false,
}) {
  const typesXml =
    types.length > 0
      ? `<Types>${types
          .map((type) => `<Type>${escapeXml(type)}</Type>`)
          .join("")}</Types>`
      : "";

  return buildSoapEnvelope(`
<GetAlarmHistoryRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  metadata="${metadata}">
  <GetAlarmHistoryParameter>
    ${alarmItemId ? `<Id>${escapeXml(alarmItemId)}</Id>` : ""}
    ${moreDataRef ? `<MoreDataRef>${escapeXml(moreDataRef)}</MoreDataRef>` : ""}
  </GetAlarmHistoryParameter>
  <GetAlarmHistoryFilter>
    ${timeFrom ? `<TimeFrom>${escapeXml(timeFrom)}</TimeFrom>` : ""}
    ${timeTo ? `<TimeTo>${escapeXml(timeTo)}</TimeTo>` : ""}
    ${
      priorityFrom !== undefined
        ? `<PriorityFrom>${priorityFrom}</PriorityFrom>`
        : ""
    }
    ${
      priorityTo !== undefined
        ? `<PriorityTo>${priorityTo}</PriorityTo>`
        : ""
    }
    ${typesXml}
  </GetAlarmHistoryFilter>
</GetAlarmHistoryRequest>`);
}

function buildSubscribeBody({
  ids,
  eventType = 0,
  eventMode = 0,
  expires = "PT30M",
  notifyToAddress = "",
  metadata = false,
}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("ids must be a non-empty array.");
  }

  const idsXml = ids
    .map((id) => `<Id>${escapeXml(id)}</Id>`)
    .join("\n");

  return buildSoapEnvelope(`
<Subscribe
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  Mode="0"
  metadata="${metadata}">
  <Delivery>
    <NotifyTo>
      <Address>${escapeXml(notifyToAddress)}</Address>
    </NotifyTo>
  </Delivery>
  <Expires>${escapeXml(expires)}</Expires>
  <Filter>
    <EventType>${eventType}</EventType>
    <Ids eventMode="${eventMode}">
      ${idsXml}
    </Ids>
  </Filter>
</Subscribe>`);
}


function buildUnsubscribeBody(subscriptionId) {
  return buildSoapEnvelope(`
<Unsubscribe
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <SubscriptionId>${escapeXml(subscriptionId)}</SubscriptionId>
</Unsubscribe>`);
}

function buildGetNotificationBody({
  subscriptionId,
  notificationId,
  moreDataRef,
}) {
  return buildSoapEnvelope(`
<GetNotificationRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <SubscriptionId>${escapeXml(subscriptionId)}</SubscriptionId>
  ${
    notificationId !== undefined
      ? `<NotificationId>${escapeXml(notificationId)}</NotificationId>`
      : ""
  }
  ${moreDataRef ? `<MoreDataRef>${escapeXml(moreDataRef)}</MoreDataRef>` : ""}
</GetNotificationRequest>`);
}

function buildRenewBody(subscriptionId, expires = "PT30M") {
  return buildSoapEnvelope(`
<Renew
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <SubscriptionId>${escapeXml(subscriptionId)}</SubscriptionId>
  <Expires>${escapeXml(expires)}</Expires>
</Renew>`);
}

function buildGetItemsBody(ids, metadata = false) {
  const normalizedIds = Array.isArray(ids) ? ids : [ids];

  const idsXml = normalizedIds
    .map((id) => `<Id>${escapeXml(id)}</Id>`)
    .join("\n");

  return buildSoapEnvelope(`
<GetItemsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  metadata="${metadata}">
  <GetItemsIds>
    ${idsXml}
  </GetItemsIds>
</GetItemsRequest>`);
}

function buildGetValuesBody(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("buildGetValuesBody expects a non-empty array of ids.");
  }

  const idXml = ids.map((id) => `<Id>${escapeXml(id)}</Id>`).join("\n");

  return buildSoapEnvelope(`
<GetValuesRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <GetValuesIds>
    ${idXml}
  </GetValuesIds>
</GetValuesRequest>`);
}

function buildSetValuesBody(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("buildSetValuesBody expects a non-empty array of items.");
  }

  const itemXml = items
    .map(
      (item) => `<ValueItem>
  <Id>${escapeXml(item.id)}</Id>
  <Value>${escapeXml(item.value)}</Value>
</ValueItem>`
    )
    .join("\n");

  return buildSoapEnvelope(`
<SetValuesRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2">
  <SetValuesItems>
    ${itemXml}
  </SetValuesItems>
</SetValuesRequest>`);
}

function parseXml(xmlText) {
  return parser.parse(xmlText);
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseGetValuesResponse(xmlText) {
  const parsed = parseXml(xmlText);

  const response = parsed.Envelope?.Body?.GetValuesResponse;
  if (!response) {
    throw new Error("Invalid GetValuesResponse SOAP XML.");
  }

  const valueItems = toArray(response.GetValuesItems?.ValueItem);
  const errorResults = toArray(response.GetValuesErrorResults?.ErrorResult);

  return {
    values: valueItems.map((item) => ({
      id: item.Id,
      state: item.State !== undefined ? Number(item.State) : null,
      value: item.Value,
    })),
    errors: errorResults.map((err) => ({
      id: err.Id,
      message: err.Message,
    })),
  };
}

function parseGetContainerItemsResponse(xmlText) {
  const parsed = parseXml(xmlText);

  const response = parsed.Envelope?.Body?.GetContainerItemsResponse;
  if (!response) {
    throw new Error("Invalid GetContainerItemsResponse SOAP XML.");
  }

  const containers = toArray(response.GetContainerItemsItems?.ContainerItem);
  const errorResults = toArray(
    response.GetContainerItemsErrorResults?.ErrorResult
  );

  return {
    containers: containers.map((container) => {
      const items = container.Items || {};

      return {
        id: container.Id,
        name: container.Name,
        description: container.Description || "",
        type: container.Type,
        containerItems: toArray(items.ContainerItems?.ContainerItem).map(
          (child) => ({
            id: child.Id,
            name: child.Name,
            description: child.Description || "",
            type: child.Type,
          })
        ),
        valueItems: toArray(items.ValueItems?.ValueItem).map((value) => ({
          id: value.Id,
          name: value.Name,
          description: value.Description || "",
          type: value.Type,
          unit: value.Unit,
          writeable:
            value.Writeable !== undefined ? Number(value.Writeable) : null,
          forceable:
            value.Forceable !== undefined ? Number(value.Forceable) : null,
          enumId: value.EnumId || null,
        })),
        historyItems: toArray(items.HistoryItems?.HistoryItem),
        alarmItems: toArray(items.AlarmItems?.AlarmItem),
      };
    }),
    errors: errorResults.map((err) => ({
      id: err.Id,
      message: err.Message,
    })),
  };
}

function parseSetValuesResponse(xmlText) {
  const parsed = parseXml(xmlText);

  const response = parsed.Envelope?.Body?.SetValuesResponse;
  if (!response) {
    throw new Error("Invalid SetValuesResponse SOAP XML.");
  }

  const results = toArray(response.SetValuesResults?.Result);

  return {
    results: results.map((result) => ({
      id: result.Id,
      success: result.Success === true || result.Success === "true",
      message: result.Message || "",
    })),
  };
}

function parseGetWebServiceInformationResponse(xmlText) {
  const parsed = parseXml(xmlText);

  const response = parsed.Envelope?.Body?.GetWebServiceInformationResponse;
  if (!response) {
    throw new Error("Invalid GetWebServiceInformationResponse SOAP XML.");
  }

  return {
    version: {
      major: Number(response.GetWebServiceInformationVersion?.MajorVersion),
      minor: response.GetWebServiceInformationVersion?.MinorVersion,
      namespace: response.GetWebServiceInformationVersion?.UsedNameSpace,
    },
    operations: toArray(
      response.GetWebServiceInformationSupportedOperations?.Operation
    ),
    profiles: toArray(
      response.GetWebServiceInformationSupportedProfiles?.Profile
    ),
    system: {
      version: response.GetWebServiceInformationSystem?.Version,
      name: response.GetWebServiceInformationSystem?.Name,
      id: response.GetWebServiceInformationSystem?.Id,
    },
  };
}

function getSoapBody(xmlText) {
  const parsed = parseXml(xmlText);
  const body = parsed.Envelope?.Body;

  if (!body) {
    throw new Error("Invalid SOAP response: Envelope.Body is missing.");
  }

  return body;
}

function extractSoapFault(xmlText) {
  const body = getSoapBody(xmlText);
  const fault = body.Fault;

  if (!fault) {
    return null;
  }

  const reasonValue = fault.Reason?.Text;
  const reason =
    typeof reasonValue === "object"
      ? reasonValue["#text"]
      : reasonValue;

  return {
    code: fault.Code?.Value || "SOAP_FAULT",
    reason: reason || "Unknown SOAP fault",
    detail: fault.Detail || null,
  };
}

function parseOperationResponse(xmlText, responseElementName) {
  const body = getSoapBody(xmlText);

  if (body.Fault) {
    const fault = extractSoapFault(xmlText);

    const error = new Error(
      `${fault.code}: ${fault.reason}`
    );

    error.soapFault = fault;
    error.body = xmlText;

    throw error;
  }

  const response = body[responseElementName];

  if (!response) {
    throw new Error(
      `Invalid SOAP response: ${responseElementName} is missing.`
    );
  }

  return response;
}

function formatXmlForDisplay(xmlText) {
  const compact = String(xmlText).replace(/>\s+</g, "><").trim();

  const lines = compact.replace(/(>)(<)(\/*)/g, "$1\n$2$3").split("\n");
  let indentLevel = 0;

  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^<\//.test(line)) {
        indentLevel = Math.max(indentLevel - 1, 0);
      }

      const formattedLine = `${"  ".repeat(indentLevel)}${line}`;

      if (
        /^<[^!?/][^>]*[^/]?>$/.test(line) &&
        !/^<[^>]+>.*<\/[^>]+>$/.test(line)
      ) {
        indentLevel += 1;
      }

      return formattedLine;
    })
    .join("\n");
}

function createEwsClient(config = {}) {
  const serviceUrl = config.serviceUrl || process.env.EWS_URL || DEFAULT_SERVICE_URL;
  const username = config.username || process.env.EWS_USER;
  const password = config.password || process.env.EWS_PASSWORD;

  assertCredentials(username, password);

  async function sendSoapRequest(soapAction, soapBody) {
    const response = await digestFetch(
      serviceUrl,
      {
        method: "POST",
        headers: {
          "Content-Type":
            `application/soap+xml; charset=utf-8; action="${soapAction}"`,
          Accept: "application/soap+xml, text/xml, */*",
        },
        body: soapBody,
      },
      {
        username,
        password,
      }
    );

    const text = await response.text();
    const soapFault = extractSoapFault(text);

    if (soapFault) {
      const error = new Error(
        `${soapFault.code}: ${soapFault.reason}`
      );

      error.status = response.status;
      error.soapFault = soapFault;
      error.body = text;

      throw error;
    }

    if (!response.ok) {
      const error = new Error(
        `EWS request failed: ${response.status} ${response.statusText}`
      );

      error.status = response.status;
      error.statusText = response.statusText;
      error.body = text;

      throw error;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      rawXml: text,
    };
  }

  async function getWebServiceInformation() {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_WEB_SERVICE_INFORMATION,
      buildGetWebServiceInformationBody()
    );

    return parseGetWebServiceInformationResponse(rawXml);
  }

  async function getContainerItems(containerId = "") {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_CONTAINER_ITEMS,
      buildGetContainerItemsBody(containerId)
    );

    return parseGetContainerItemsResponse(rawXml);
  }

  async function getValues(ids) {
    const normalizedIds = Array.isArray(ids) ? ids : [ids];

    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_VALUES,
      buildGetValuesBody(normalizedIds)
    );

    return parseGetValuesResponse(rawXml);
  }

  async function setValues(items) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.SET_VALUES,
      buildSetValuesBody(items)
    );

    return parseSetValuesResponse(rawXml);
  }

  async function getItems(ids, metadata = false) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_ITEMS,
      buildGetItemsBody(ids, metadata)
    );

    return parseOperationResponse(rawXml, "GetItemsResponse");
  }

  async function getAlarmEvents(options = {}) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_ALARM_EVENTS,
      buildGetAlarmEventsBody(options)
    );

    return parseOperationResponse(rawXml, "GetAlarmEventsResponse");
  }

  async function getUpdatedAlarmEvents(options) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_UPDATED_ALARM_EVENTS,
      buildGetUpdatedAlarmEventsBody(options)
    );

    return parseOperationResponse(
      rawXml,
      "GetUpdatedAlarmEventsResponse"
    );
  }

  async function getAlarmEventTypes() {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_ALARM_EVENT_TYPES,
      buildGetAlarmEventTypesBody()
    );

    return parseOperationResponse(
      rawXml,
      "GetAlarmEventTypesResponse"
    );
  }

  async function acknowledgeAlarmEvents(eventIds) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.ACKNOWLEDGE_ALARM_EVENTS,
      buildAcknowledgeAlarmEventsBody(eventIds)
    );

    return parseOperationResponse(
      rawXml,
      "AcknowledgeAlarmEventsResponse"
    );
  }

  async function getHistory(options) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_HISTORY,
      buildGetHistoryBody(options)
    );

    return parseOperationResponse(rawXml, "GetHistoryResponse");
  }

  async function forceValues(items) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.FORCE_VALUES,
      buildForceValuesBody(items)
    );

    return parseOperationResponse(rawXml, "ForceValuesResponse");
  }

  async function unforceValues(ids) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.UNFORCE_VALUES,
      buildUnforceValuesBody(ids)
    );

    return parseOperationResponse(
      rawXml,
      "UnforceValuesResponse"
    );
  }

  async function getEnums(enumIds) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_ENUMS,
      buildGetEnumsBody(enumIds)
    );

    return parseOperationResponse(rawXml, "GetEnumsResponse");
  }

  async function getHierarchicalInformation(itemId) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_HIERARCHICAL_INFORMATION,
      buildGetHierarchicalInformationBody(itemId)
    );

    return parseOperationResponse(
      rawXml,
      "GetHierarchicalInformationResponse"
    );
  }

  async function getAlarmHistory(options) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_ALARM_HISTORY,
      buildGetAlarmHistoryBody(options)
    );

    return parseOperationResponse(
      rawXml,
      "GetAlarmHistoryResponse"
    );
  }

  async function subscribe(options) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.SUBSCRIBE,
      buildSubscribeBody(options)
    );

    return parseOperationResponse(rawXml, "SubscribeResponse");
  }

  async function getNotification(options) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.GET_NOTIFICATION,
      buildGetNotificationBody(options)
    );

    return parseOperationResponse(
      rawXml,
      "GetNotificationResponse"
    );
  }

  async function renew(subscriptionId, expires = "PT30M") {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.RENEW,
      buildRenewBody(subscriptionId, expires)
    );

    return parseOperationResponse(rawXml, "RenewResponse");
  }

  async function unsubscribe(subscriptionId) {
    const { rawXml } = await sendSoapRequest(
      SOAP_ACTIONS.UNSUBSCRIBE,
      buildUnsubscribeBody(subscriptionId)
    );

    return parseOperationResponse(rawXml, "UnsubscribeResponse");
  }

  return {
    serviceUrl,

    getWebServiceInformation,
    getContainerItems,
    getItems,
    getValues,
    setValues,

    getAlarmEvents,
    getUpdatedAlarmEvents,
    getAlarmEventTypes,
    acknowledgeAlarmEvents,

    getHistory,
    getAlarmHistory,

    forceValues,
    unforceValues,

    getEnums,
    getHierarchicalInformation,

    subscribe,
    getNotification,
    renew,
    unsubscribe,

    sendSoapRequest,
  };
}

module.exports = {
  createEwsClient,
  escapeXml,
  formatXmlForDisplay,

  parseOperationResponse,
  extractSoapFault,

  parseGetValuesResponse,
  parseGetContainerItemsResponse,
  parseGetWebServiceInformationResponse,
};