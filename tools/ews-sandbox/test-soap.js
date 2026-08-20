const soap = require("soap");

// SAMO ZA TESTIRANJE zbog self-signed certifikata.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const ENDPOINT_URL =
  process.env.EWS_URL ||
  "https://bms.iot-electric.hr/EcoStruxure/DataExchange";
const WSDL_URL = `${ENDPOINT_URL}?wsdl`;

const USERNAME = process.env.EWS_USER;
const PASSWORD = process.env.EWS_PASSWORD;

const MODE = process.argv[2] || "basic";

if (MODE !== "describe" && (!USERNAME || !PASSWORD)) {
  console.error("Missing credentials.");
  console.error("Set EWS_USER and EWS_PASSWORD environment variables.");
  process.exit(1);
}

const clientOptions = {
  forceSoap12Headers: true,
  wsdl_options: {
    rejectUnauthorized: false,
    strictSSL: false,
  },
};

function createClient(url, options) {
  return new Promise((resolve, reject) => {
    soap.createClient(url, options, (err, client) => {
      if (err) return reject(err);
      resolve(client);
    });
  });
}

async function main() {
  console.log("Creating SOAP client...");
  console.log("Mode:", MODE);
  console.log();

  const client = await createClient(WSDL_URL, clientOptions);

  client.setEndpoint(ENDPOINT_URL);

  console.log("SOAP client created.");
  console.log();

  console.log("Available methods:");
  console.log(JSON.stringify(client.describe(), null, 2));
  console.log();

  if (MODE === "describe") {
    console.log("Describe only. No SOAP call executed.");
    return;
  }

  if (MODE === "basic") {
    console.log("Using BasicAuthSecurity...");
    client.setSecurity(new soap.BasicAuthSecurity(USERNAME, PASSWORD));
  } else if (MODE === "wsse-text") {
    console.log("Using WS-Security PasswordText...");
    client.setSecurity(
      new soap.WSSecurity(USERNAME, PASSWORD, {
        passwordType: "PasswordText",
        hasTimeStamp: true,
        hasTokenCreated: true,
        hasNonce: true,
      })
    );
  } else if (MODE === "wsse-digest") {
    console.log("Using WS-Security PasswordDigest...");
    client.setSecurity(
      new soap.WSSecurity(USERNAME, PASSWORD, {
        passwordType: "PasswordDigest",
        hasTimeStamp: true,
        hasTokenCreated: true,
        hasNonce: true,
      })
    );
  } else if (MODE === "none") {
    console.log("Using no auth...");
  } else {
    throw new Error(`Unknown mode: ${MODE}`);
  }

  console.log();
  console.log("Calling GetWebServiceInformation...");
  console.log();

  client.GetWebServiceInformation({}, (err, result, rawResponse) => {
    if (err) {
      console.error("SOAP call failed.");
      console.error();

      console.error("Error message:");
      console.error(err.message || err);
      console.error();

      if (err.response?.statusCode) {
        console.error("HTTP status:");
        console.error(err.response.statusCode);
        console.error();
      }

      if (err.response?.headers) {
        console.error("Response headers:");
        console.error(JSON.stringify(err.response.headers, null, 2));
        console.error();
      }

      if (err.body) {
        console.error("Error body:");
        console.error(err.body);
        console.error();
      }

      console.error("Last SOAP request:");
      console.error(client.lastRequest);

      return;
    }

    console.log("SOAP call succeeded.");
    console.log();

    console.log("Parsed result:");
    console.log(JSON.stringify(result, null, 2));
    console.log();

    console.log("Raw response:");
    console.log(rawResponse);
  });
}

main().catch((err) => {
  console.error("Fatal error:");
  console.error(err);
});
