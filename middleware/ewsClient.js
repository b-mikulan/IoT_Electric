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

// IDs, continuation tokens and metadata values are strings, even when numeric.
const containerParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});
const MAX_CONTAINER_PAGES = 100;
const MAX_CONTAINER_ITEMS = 50_000;

function assertCredentials(username, password) {
  if (!username || !password) {
    throw new Error(
      "Missing credentials. Set EWS_USER and EWS_PASSWORD environment variables."
    );
  }
}

function sanitizeEnvValue(value) {
  if (value === undefined || value === null) return value;
  return String(value).replace(/\r/g, "").trim();
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

function buildGetContainerItemsBody(containerId, { metadata = false, moreDataRef = "" } = {}) {
  return buildSoapEnvelope(`
<GetContainerItemsRequest
  xmlns="${EWS_NAMESPACE}"
  version="1.2"
  metadata="${metadata}">
  <GetContainerItemsIds>
    <Id>${escapeXml(containerId)}</Id>
  </GetContainerItemsIds>
  <GetContainerItemsParameter>
    <MoreDataRef>${escapeXml(moreDataRef)}</MoreDataRef>
  </GetContainerItemsParameter>
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
  const parsed = containerParser.parse(xmlText);

  const response = parsed.Envelope?.Body?.GetContainerItemsResponse;
  if (!response) {
    throw new Error("Invalid GetContainerItemsResponse SOAP XML.");
  }

  const containers = toArray(response.GetContainerItemsItems?.ContainerItem);
  const errorResults = toArray(
    response.GetContainerItemsErrorResults?.ErrorResult
  );
  const errors = errorResults.map((err) => ({ id: err.Id, message: err.Message }));
  let status;
  try {
    status = parseContainerStatus(response.GetContainerItemsStatus);
  } catch (error) {
    status = { moreDataAvailable: null, moreDataRef: response.GetContainerItemsStatus?.MoreDataRef ?? null };
    errors.push({ id: containers[0]?.Id || "", message: error.message });
  }

  return {
    containers: containers.map((container) => {
      const items = container.Items || {};

      return {
        id: container.Id,
        name: container.Name,
        description: container.Description || "",
        type: container.Type,
        ...(container.Metadata !== undefined ? { metadata: container.Metadata } : {}),
        containerItems: toArray(items.ContainerItems?.ContainerItem).map(
          (child) => ({
            id: child.Id,
            name: child.Name,
            description: child.Description || "",
            type: child.Type,
            ...(child.Metadata !== undefined ? { metadata: child.Metadata } : {}),
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
          ...(value.Metadata !== undefined ? { metadata: value.Metadata } : {}),
        })),
        historyItems: toArray(items.HistoryItems?.HistoryItem),
        alarmItems: toArray(items.AlarmItems?.AlarmItem),
      };
    }),
    errors,
    status,
  };
}

function parseContainerStatus(status) {
  if (status === undefined) return null;
  const flag = status.MoreDataAvailable;
  let moreDataAvailable = null;
  if (flag !== undefined) {
    const value = String(flag).trim();
    if (value === "true" || value === "1") moreDataAvailable = true;
    else if (value === "false" || value === "0") moreDataAvailable = false;
    else throw new Error("Invalid GetContainerItems MoreDataAvailable flag.");
  }
  return { moreDataAvailable, moreDataRef: status.MoreDataRef ?? null };
}

function metadataIdentity(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.Id !== undefined) return `id:${value.Id}`;
    if (value.Name !== undefined) return `name:${value.Name}`;
  }
  return JSON.stringify(value);
}

function mergeMetadata(previous, next) {
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  const objects = previous && next && typeof previous === "object" && typeof next === "object";
  if (Array.isArray(previous) || Array.isArray(next) ||
      (objects && metadataIdentity(previous) !== metadataIdentity(next) &&
       (previous.Id !== undefined || previous.Name !== undefined) &&
       (next.Id !== undefined || next.Name !== undefined))) {
    const entries = new Map();
    for (const value of [...toArray(previous), ...toArray(next)]) {
      const key = metadataIdentity(value);
      entries.set(key, entries.has(key) ? mergeMetadata(entries.get(key), value) : value);
    }
    return [...entries.values()];
  }
  if (objects) {
    const merged = { ...previous };
    for (const [key, value] of Object.entries(next)) merged[key] = mergeMetadata(previous[key], value);
    return merged;
  }
  return next;
}

function mergeContainerItem(previous, next) {
  const merged = { ...previous, ...next };
  for (const field of ["metadata", "Metadata"]) {
    if (previous[field] !== undefined || next[field] !== undefined) {
      merged[field] = mergeMetadata(previous[field], next[field]);
    }
  }
  return merged;
}

function mergeContainerPage(collection, page) {
  const { containers } = collection;
  for (const container of page.containers) {
    const previous = containers.get(container.id);
    if (!previous) {
      if (collection.itemCount >= MAX_CONTAINER_ITEMS) return false;
      collection.itemCount += 1;
    }
    const merged = mergeContainerItem(previous || {}, container);
    const fields = ["containerItems", "valueItems", "historyItems", "alarmItems"];
    // Initialize all lists before processing so a limit never exposes uncounted items.
    for (const field of fields) merged[field] = previous?.[field] || [];
    containers.set(container.id, merged);
    for (const field of fields) {
      const items = new Map(merged[field].map((item) => [item.id ?? item.Id ?? JSON.stringify(item), item]));
      for (const item of container[field]) {
        const key = item.id ?? item.Id ?? JSON.stringify(item);
        if (items.has(key)) items.set(key, mergeContainerItem(items.get(key), item));
        else {
          if (collection.itemCount >= MAX_CONTAINER_ITEMS) {
            merged[field] = [...items.values()];
            return false;
          }
          items.set(key, item);
          collection.itemCount += 1;
        }
      }
      merged[field] = [...items.values()];
    }
  }
  return true;
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
  const serviceUrlRaw = config.serviceUrl || process.env.EWS_URL || DEFAULT_SERVICE_URL;
  const usernameRaw = config.username || process.env.EWS_USER;
  const passwordRaw = config.password || process.env.EWS_PASSWORD;

  const serviceUrl = sanitizeEnvValue(serviceUrlRaw) || DEFAULT_SERVICE_URL;
  const username = sanitizeEnvValue(usernameRaw);
  const password = sanitizeEnvValue(passwordRaw);

  assertCredentials(username, password);

  const containerTimeoutMs = Number(config.containerTimeoutMs ?? process.env.EWS_CONTAINER_TIMEOUT_MS ?? 8000);
  if (!Number.isInteger(containerTimeoutMs) || containerTimeoutMs <= 0 || containerTimeoutMs > 2_147_483_647) {
    throw new Error("EWS_CONTAINER_TIMEOUT_MS must be a positive integer timeout in milliseconds.");
  }

  async function sendSoapRequest(soapAction, soapBody, { signal } = {}) {
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
        ...(signal ? { signal } : {}),
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

  async function getContainerItems(containerId = "", { metadata = false, moreDataRef = "", allPages = true } = {}) {
    if (typeof containerId !== "string" || typeof moreDataRef !== "string" ||
        typeof metadata !== "boolean" || typeof allPages !== "boolean") {
      throw Object.assign(new Error("Invalid container discovery options."), { status: 400 });
    }
    const result = { containers: [], errors: [], status: null, complete: null, pagesRead: 0 };
    const collection = { containers: new Map(), itemCount: 0 };
    const usedTokens = new Set();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), containerTimeoutMs);
    let token = moreDataRef;
    function incomplete(message, soapFault) {
      result.complete = false;
      result.errors.push({ id: containerId, message, ...(soapFault ? { soapFault } : {}) });
    }
    try {
      while (true) {
        if (token) usedTokens.add(token);
        let page;
        try {
          const { rawXml } = await sendSoapRequest(
            SOAP_ACTIONS.GET_CONTAINER_ITEMS,
            buildGetContainerItemsBody(containerId, { metadata, moreDataRef: token }),
            { signal: controller.signal }
          );
          page = parseGetContainerItemsResponse(rawXml);
        } catch (error) {
          const failure = controller.signal.aborted
            ? Object.assign(new Error("Container discovery timed out."), { status: 504 })
            : error;
          if (result.pagesRead === 0) throw failure;
          incomplete(`Container continuation failed: ${failure.message}`, failure.soapFault);
          break;
        }
        result.pagesRead += 1;
        const withinLimit = mergeContainerPage(collection, page);
        result.containers = [...collection.containers.values()];
        result.errors.push(...page.errors);
        result.status = page.status;
        if (!withinLimit) {
          // The next-page token would skip the uncollected remainder of this page.
          if (result.status) result.status = { ...result.status, moreDataRef: null };
          incomplete(`Container discovery exceeded ${MAX_CONTAINER_ITEMS} items. This page was truncated; use a narrower container request.`);
          break;
        }
        if (page.status?.moreDataAvailable === false) {
          result.complete = result.errors.length === 0;
          break;
        }
        // Older EBO servers omit status. Preserve that uncertainty without inventing a cursor.
        if (page.status?.moreDataAvailable !== true) {
          result.complete = result.errors.length ? false : null;
          break;
        }
        result.complete = false;
        const nextToken = page.status.moreDataRef;
        if (typeof nextToken !== "string" || nextToken.length === 0) {
          incomplete("Container response advertises more data without a continuation token.");
          break;
        }
        if (usedTokens.has(nextToken)) {
          incomplete("Container response repeated a continuation token.");
          break;
        }
        if (!allPages) break;
        if (result.pagesRead >= MAX_CONTAINER_PAGES) {
          incomplete(`Container discovery exceeded ${MAX_CONTAINER_PAGES} pages.`);
          break;
        }
        token = nextToken;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
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
