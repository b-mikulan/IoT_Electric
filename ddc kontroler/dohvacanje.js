const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const SERVICE_URL =
  process.env.EWS_URL || "https://bms.iot-electric.hr/EcoStruxure/DataExchange";

const USERNAME = process.env.EWS_USER;
const PASSWORD = process.env.EWS_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error("Missing credentials.");
  console.error("Set EWS_USER and EWS_PASSWORD environment variables.");
  process.exit(1);
}



function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


const Idtest = "01/ES/Test4EWS/Values/Analog Value";

const SOAP_ACTION =
  "http://www.schneider-electric.com/common/dataexchange/2011/05/GetValuesIn";

const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header/>
  <s:Body>
    <GetValuesRequest
      xmlns="http://www.schneider-electric.com/common/dataexchange/2011/05"
      version="1.2">
      <GetValuesIds>
        <Id>01/ES/Test4EWS/Values/Analog Value</Id>
        <Id>01/ES/Test4EWS/Values/Digital Value</Id>
        <Id>01/ES/Test4EWS/Values/String Value</Id>
        <Id>01/ES/Test4EWS/Values/Time Stamp Value</Id>
      </GetValuesIds>
    </GetValuesRequest>
  </s:Body>
</s:Envelope>`;

function parseDigestChallenge(wwwAuthenticateHeader) {
  if (!wwwAuthenticateHeader) {
    throw new Error("Missing WWW-Authenticate header");
  }

  const digestIndex = wwwAuthenticateHeader.toLowerCase().indexOf("digest ");
  if (digestIndex === -1) {
    throw new Error(`Server did not return Digest auth challenge: ${wwwAuthenticateHeader}`);
  }

  const challenge = wwwAuthenticateHeader.slice(digestIndex + "digest ".length);

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

  throw new Error(`Unsupported digest algorithm from server: ${algorithmFromServer}`);
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
    throw new Error(`Invalid Digest challenge: ${JSON.stringify(challenge, null, 2)}`);
  }

  let ha1 = hash(hashAlgorithm, `${USERNAME}:${realm}:${PASSWORD}`);

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
    `username="${USERNAME}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithmRaw}`,
    `response="${response}"`,
  ];

  if (opaque) parts.push(`opaque="${opaque}"`);

  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }

  return `Digest ${parts.join(", ")}`;
}

async function digestFetch(url, options) {
  const method = options.method || "GET";
  const body = options.body || "";

  const firstResponse = await fetch(url, options);

  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  const wwwAuthenticate = firstResponse.headers.get("www-authenticate");
  console.log("Server auth challenge:");
  console.log(wwwAuthenticate);
  console.log();

  const challenge = parseDigestChallenge(wwwAuthenticate);

  const authorization = buildDigestAuthorizationHeader({
    method,
    url,
    body,
    challenge,
  });

  const secondResponse = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: authorization,
    },
  });

  return secondResponse;
}

function formatXmlForDisplay(xmlText) {
  const compact = String(xmlText)
    .replace(/>\s+</g, "><")
    .trim();

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

async function main() {
  const response = await digestFetch(SERVICE_URL, {
    method: "POST",
    headers: {
      "Content-Type": `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"`,
      Accept: "application/soap+xml, text/xml, */*",
    },
    body: soapBody,
  });

  const text = await response.text();

  console.log("HTTP status:", response.status, response.statusText);
  console.log("Response body:");
  console.log(formatXmlForDisplay(text));
}

main().catch((err) => {
  console.error("Request failed:");
  console.error(err);
});