const { createEwsClient } = require("../ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function main() {
    const ews = createEwsClient();
  


    // test dodavanja vrijednosti na server
    const ids = [
        "01/ES/Test4EWS/Values/Analog Value",
    ];

    const values = [
        {
            id: "01/ES/Test4EWS/Values/Analog Value",
            value: 69
        }
    ];

    const result = await ews.setValues(values);
    console.log(JSON.stringify(result, null, 2));

    
}

main().catch((err) => {
  console.error("Request failed:");
  console.error(err.message);

  if (err.body) {
    console.error("Response body:");
    console.error(err.body);
  }
});