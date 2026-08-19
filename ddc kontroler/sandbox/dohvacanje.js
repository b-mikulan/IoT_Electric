const { createEwsClient } = require("../ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function main() {
  const ews = createEwsClient();

  const ids = [
    "01/ES/Test4EWS/Values/Analog Value",
    "01/ES/Test4EWS/Values/Digital Value",
    "01/ES/Test4EWS/Values/String Value",
    "01/ES/Test4EWS/Values/Time Stamp Value",
  ];

  const result = await ews.getValues(ids);

  console.log(JSON.stringify(result, null, 2));

  const getInfoResult = await ews.getWebServiceInformation();
  console.log(JSON.stringify(getInfoResult, null, 2));  

  const getContainerResult = await ews.getContainerItems("00/ES/Test4EWS");
  console.log(JSON.stringify(getContainerResult, null, 2));
}

main().catch((err) => {
  console.error("Request failed:");
  console.error(err.message);

  if (err.body) {
    console.error("Response body:");
    console.error(err.body);
  }
});