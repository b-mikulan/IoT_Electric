const { createEwsClient } = require("./ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function main() {
    const ews = createEwsClient();
  


    // test dodavanja vrijednosti na server
    const ids = [
        "01/ES/Test4EWS/Values/String Value",
    ];

    const values = [
        {
            id: "01/ES/Test4EWS/Values/String Value",
            value: "Testna vrijednost, prije je pisalo Hello World"
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