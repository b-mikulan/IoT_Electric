const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");

const DEFAULT_SERVICE_URL =
  "https://bms.iot-electric.hr/EcoStruxure/DataExchange";

const EWS_NAMESPACE =
  "http://www.schneider-electric.com/common/dataexchange/2011/05";

const SOAP_ACTIONS = {
  GET_WEB_SERVICE_INFORMATION: `${EWS_NAMESPACE}/GetWebServiceInformationIn`,
  GET_CONTAINER_ITEMS: `${EWS_NAMESPACE}/GetContainerItemsIn`,
  GET_VALUES: `${EWS_NAMESPACE}/GetValuesIn`,
  SET_VALUES: `${EWS_NAMESPACE}/SetValuesIn`,
};

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

function buildGetValuesBody(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("buildGetValuesBody expects a non-empty array of ids.");
  }

  const idXml = ids.map((id) => `<Id>${escapeXml(id)}</Id>`).join("\n        ");

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
    .join("\n        ");

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
          "Content-Type": `application/soap+xml; charset=utf-8; action="${soapAction}"`,
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

  return {
    serviceUrl,
    getWebServiceInformation,
    getContainerItems,
    getValues,
    setValues,
    sendSoapRequest,
  };
}

module.exports = {
  createEwsClient,
  escapeXml,
  formatXmlForDisplay,
  parseGetValuesResponse,
  parseGetContainerItemsResponse,
  parseGetWebServiceInformationResponse,
};