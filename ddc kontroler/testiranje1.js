const { createEwsClient } = require("./ewsClient");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function main() {
    const ews = createEwsClient();

    const items_result = await ews.getItems([
        "01/ES/Test4EWS/Values/Analog Value",
        "01/ES/Test4EWS/Values/Digital Value",
    ]);

    console.log(JSON.stringify(items_result, null, 2));

    const alarm_result = await ews.getAlarmEventTypes();
    console.log(JSON.stringify(alarm_result, null, 2));

    const hierarchy_result = await ews.getHierarchicalInformation("01/ES/Test4EWS");
    console.log(JSON.stringify(hierarchy_result, null, 2));

    const enums_result = await ews.getEnums([
        "~/system.pt.Boolean",
    ]);

    console.log(JSON.stringify(enums_result, null, 2));
}

main().catch((error) => {
    console.error(error.message);

    if (error.soapFault) {
        console.error(
        JSON.stringify(error.soapFault, null, 2)
        );
    }

    if (error.body) {
        console.error(error.body);
    }
});