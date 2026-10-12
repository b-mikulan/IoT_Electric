const test = require("node:test");
const assert = require("node:assert/strict");
const { XMLParser } = require("fast-xml-parser");
const { createEwsClient } = require("../middleware/ewsClient");

const namespace = "http://www.schneider-electric.com/common/dataexchange/2011/05";
const clientConfig = { serviceUrl: "https://ews.test.invalid/DataExchange", username: "test-client", password: "test-password" };
const requestParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false });

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function soap(body) {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;
}

function page({ containerId = "00/server/device", items = "", metadata = "", status = null, errors = "" } = {}) {
  const statusXml = status === null ? "" : `<GetContainerItemsStatus><MoreDataAvailable>${status.more}</MoreDataAvailable>${status.token === undefined ? "" : `<MoreDataRef>${xmlEscape(status.token)}</MoreDataRef>`}</GetContainerItemsStatus>`;
  return soap(`<GetContainerItemsResponse xmlns="${namespace}"><GetContainerItemsItems><ContainerItem><Id>${xmlEscape(containerId)}</Id><Name>Device</Name><Description>  Kitchen  </Description><Type>folder</Type>${metadata}<Items>${items}</Items></ContainerItem></GetContainerItemsItems>${statusXml}${errors ? `<GetContainerItemsErrorResults>${errors}</GetContainerItemsErrorResults>` : ""}</GetContainerItemsResponse>`);
}

function value(id, metadata = "") {
  return `<ValueItem><Id>${xmlEscape(id)}</Id><Name>Light</Name><Type>Double</Type><Unit>%</Unit><Writeable>1</Writeable><Forceable>0</Forceable>${metadata}</ValueItem>`;
}

function child(id, metadata = "") {
  return `<ContainerItem><Id>${xmlEscape(id)}</Id><Name>Child</Name><Type>folder</Type>${metadata}</ContainerItem>`;
}

function fault() {
  return soap("<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text xml:lang=\"en\">Operation not supported</s:Text></s:Reason></s:Fault>");
}

function mockPages(t, responses) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, clientConfig.serviceUrl);
    assert.equal(options.method, "POST");
    const request = requestParser.parse(options.body).Envelope.Body.GetContainerItemsRequest;
    assert.ok(request, "Only the container read operation may be issued");
    requests.push(request);
    const response = responses[requests.length - 1];
    assert.notEqual(response, undefined, "Unexpected additional page request");
    if (response instanceof Error) throw response;
    return new Response(response, { status: 200 });
  });
  return requests;
}

test("container reads preserve exact IDs, nested metadata and unknown legacy completeness", async (t) => {
  const numericId = "000123456789012345678901234567890";
  const nestedMetadata = "<Metadata><Property name=\"room\">  Kitchen  </Property><Property name=\"owner\"><Ref>000012345678901234567890</Ref><Tag>A &amp; B</Tag></Property></Metadata>";
  const requests = mockPages(t, [page({
    containerId: numericId, metadata: nestedMetadata,
    items: `<ContainerItems>${child("00/server/device/child", nestedMetadata)}</ContainerItems><ValueItems>${value(numericId, nestedMetadata)}${value("01/server/device/plain")}</ValueItems><HistoryItems><HistoryItem><Id>02/log</Id><ValueItemId>${numericId}</ValueItemId><Metadata><Source>history</Source></Metadata></HistoryItem></HistoryItems><AlarmItems><AlarmItem><Id>04/alarm</Id><ValueItemId>${numericId}</ValueItemId><Metadata><Source>alarm</Source></Metadata></AlarmItem></AlarmItems>`,
  })]);
  const result = await createEwsClient(clientConfig).getContainerItems(numericId, { metadata: true });
  const expectedMetadata = { Property: [{ "#text": "  Kitchen  ", "@_name": "room" }, { Ref: "000012345678901234567890", Tag: "A & B", "@_name": "owner" }] };
  assert.equal(result.containers[0].id, numericId);
  assert.equal(result.containers[0].description, "  Kitchen  ");
  assert.deepEqual(result.containers[0].metadata, expectedMetadata);
  assert.deepEqual(result.containers[0].containerItems[0].metadata, expectedMetadata);
  assert.equal(result.containers[0].valueItems[0].id, numericId);
  assert.deepEqual(result.containers[0].valueItems[0].metadata, expectedMetadata);
  assert.equal(Object.hasOwn(result.containers[0].valueItems[1], "metadata"), false);
  assert.equal(result.containers[0].historyItems[0].ValueItemId, numericId);
  assert.deepEqual(result.containers[0].historyItems[0].Metadata, { Source: "history" });
  assert.deepEqual(result.containers[0].alarmItems[0].Metadata, { Source: "alarm" });
  assert.equal(result.status, null);
  assert.equal(result.complete, null);
  assert.equal(result.pagesRead, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]["@_metadata"], "true");
});

test("container paging merges all item kinds by case-sensitive ID and preserves opaque continuation tokens", async (t) => {
  const token = " 000123456789012345678901234567890 & <next> \"' ";
  const firstItems = `<ContainerItems>${child("00/device/Child")}</ContainerItems><ValueItems>${value("01/device/Light")}</ValueItems><HistoryItems><HistoryItem><Id>02/device/Log</Id><Name>Log</Name></HistoryItem></HistoryItems><AlarmItems><AlarmItem><Id>04/device/Alarm</Id><Name>Alarm</Name></AlarmItem></AlarmItems>`;
  const secondItems = `<ContainerItems>${child("00/device/Child", "<Metadata><Floor>1</Floor></Metadata>")}${child("00/device/child")}</ContainerItems><ValueItems>${value("01/device/Light", "<Metadata><Role>feedback</Role></Metadata>")}${value("01/device/light")}</ValueItems><HistoryItems><HistoryItem><Id>02/device/Log</Id><Name>Log</Name><Metadata><Role>history</Role></Metadata></HistoryItem><HistoryItem><Id>02/device/log</Id></HistoryItem></HistoryItems><AlarmItems><AlarmItem><Id>04/device/Alarm</Id><Name>Alarm</Name><Metadata><Role>alarm</Role></Metadata></AlarmItem><AlarmItem><Id>04/device/alarm</Id></AlarmItem></AlarmItems>`;
  const requests = mockPages(t, [
    page({ metadata: "<Metadata><Room>Kitchen</Room></Metadata>", items: firstItems, status: { more: "true", token } }),
    page({ metadata: "<Metadata><Zone>Z312</Zone></Metadata>", items: secondItems, status: { more: "false" } }),
  ]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device", { metadata: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].GetContainerItemsParameter.MoreDataRef, token);
  assert.equal(requests[1].GetContainerItemsIds.Id, "00/server/device");
  assert.equal(requests[1]["@_metadata"], "true");
  assert.equal(result.containers.length, 1);
  const merged = result.containers[0];
  assert.deepEqual(merged.metadata, { Room: "Kitchen", Zone: "Z312" });
  assert.deepEqual(merged.containerItems.map(({ id }) => id), ["00/device/Child", "00/device/child"]);
  assert.deepEqual(merged.valueItems.map(({ id }) => id), ["01/device/Light", "01/device/light"]);
  assert.deepEqual(merged.historyItems.map(({ Id }) => Id), ["02/device/Log", "02/device/log"]);
  assert.deepEqual(merged.alarmItems.map(({ Id }) => Id), ["04/device/Alarm", "04/device/alarm"]);
  assert.deepEqual(merged.valueItems[0].metadata, { Role: "feedback" });
  assert.deepEqual(merged.historyItems[0].Metadata, { Role: "history" });
  assert.deepEqual(merged.alarmItems[0].Metadata, { Role: "alarm" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.complete, true);
  assert.equal(result.pagesRead, 2);
  assert.equal(result.status.moreDataAvailable, false);
});

test("single-page container reads can resume at an exact token without fetching later pages", async (t) => {
  const initialToken = " 0012345678901234567890 & <resume> ";
  const nextToken = " 0009876543210987654321 ";
  const requests = mockPages(t, [page({ status: { more: "true", token: nextToken } })]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device", { allPages: false, moreDataRef: initialToken });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].GetContainerItemsParameter.MoreDataRef, initialToken);
  assert.deepEqual(result.status, { moreDataAvailable: true, moreDataRef: nextToken });
  assert.equal(result.complete, false);
  assert.equal(result.pagesRead, 1);
});

test("aggregated container reads can resume and retain a digits-only continuation token", async (t) => {
  const resume = "0000123456789012345678901234567890";
  const next = "0000987654321098765432109876543210";
  const requests = mockPages(t, [page({ status: { more: "true", token: next } }), page({ status: { more: "false" } })]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device", { moreDataRef: resume });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].GetContainerItemsParameter.MoreDataRef, resume);
  assert.equal(requests[1].GetContainerItemsParameter.MoreDataRef, next);
  assert.equal(result.complete, true);
  assert.equal(result.pagesRead, 2);
});

test("XML boolean paging flags preserve leading-zero tokens and ignore stale tokens on the last page", async (t) => {
  const requests = mockPages(t, [page({ status: { more: "1", token: "000123" } }), page({ status: { more: "0", token: "stale-unused" } })]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].GetContainerItemsParameter.MoreDataRef, "000123");
  assert.equal(result.status.moreDataAvailable, false);
  assert.equal(result.complete, true);
  assert.equal(result.pagesRead, 2);
});

test("metadata models and categories retain identically named properties and string values across pages", async (t) => {
  const category = (name, propertyValue) => `<Category><Name>${name}</Name><Property><Name>code</Name><Value>${propertyValue}</Value></Property></Category>`;
  const model = (id, categories) => `<MetaModel version="1.0"><Id>${id}</Id>${categories}</MetaModel>`;
  const firstMetadata = `<Metadata>${model("model-A", category("Location", "001"))}</Metadata>`;
  const secondMetadata = `<Metadata>${model("model-A", category("Control", "false"))}${model("model-B", category("Location", "005"))}</Metadata>`;
  mockPages(t, [
    page({ metadata: firstMetadata, items: `<ValueItems>${value("01/device/point", firstMetadata)}</ValueItems>`, status: { more: "true", token: "next" } }),
    page({ metadata: secondMetadata, items: `<ValueItems>${value("01/device/point", secondMetadata)}</ValueItems>`, status: { more: "false" } }),
  ]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device", { metadata: true });
  const models = result.containers[0].metadata.MetaModel;
  assert.equal(models.length, 2);
  const firstModel = models.find(({ Id }) => Id === "model-A");
  const secondModel = models.find(({ Id }) => Id === "model-B");
  assert.equal(firstModel["@_version"], "1.0");
  assert.deepEqual(firstModel.Category.map(({ Name, Property }) => ({ category: Name, property: Property.Name, value: Property.Value })), [
    { category: "Location", property: "code", value: "001" },
    { category: "Control", property: "code", value: "false" },
  ]);
  assert.deepEqual(secondModel.Category, { Name: "Location", Property: { Name: "code", Value: "005" } });
  assert.deepEqual(result.containers[0].valueItems[0].metadata.MetaModel, models);
  assert.equal(result.complete, true);
});

test("container paging preserves data when a server omits or repeats a continuation token", async (t) => {
  const requests = mockPages(t, [
    page({ items: `<ValueItems>${value("01/device/one")}</ValueItems>`, status: { more: "true" } }),
    page({ status: { more: "true", token: "repeat" } }),
    page({ items: `<ValueItems>${value("01/device/two")}</ValueItems>`, status: { more: "true", token: "repeat" } }),
  ]);
  const client = createEwsClient(clientConfig);
  const missing = await client.getContainerItems("00/server/device");
  assert.equal(missing.complete, false);
  assert.equal(missing.pagesRead, 1);
  assert.equal(missing.containers[0].valueItems[0].id, "01/device/one");
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.errors[0].id, "00/server/device");
  assert.match(missing.errors[0].message, /token|MoreDataRef|continuation/i);
  const repeated = await client.getContainerItems("00/server/device");
  assert.equal(requests.length, 3);
  assert.equal(repeated.complete, false);
  assert.equal(repeated.pagesRead, 2);
  assert.equal(repeated.containers[0].valueItems[0].id, "01/device/two");
  assert.equal(repeated.errors[0].id, "00/server/device");
  assert.match(repeated.errors[0].message, /repeat|token|continuation/i);
});

test("a SOAP fault after a successful container page retains data and SOAP details", async (t) => {
  mockPages(t, [page({ items: `<ValueItems>${value("01/device/one")}</ValueItems>`, status: { more: "true", token: "next" } }), fault()]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device");
  assert.equal(result.complete, false);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.containers[0].valueItems[0].id, "01/device/one");
  assert.equal(result.errors[0].id, "00/server/device");
  assert.equal(result.errors[0].soapFault.reason, "Operation not supported");
});

test("a fault on an initial metadata request is rejected without silently retrying without metadata", async (t) => {
  const requests = mockPages(t, [fault()]);
  await assert.rejects(createEwsClient(clientConfig).getContainerItems("00/server/device", { metadata: true }), (error) => error.status === 200 && error.soapFault.reason === "Operation not supported");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]["@_metadata"], "true");
});

test("container completeness remains unconfirmed without status and false when item errors exist", async (t) => {
  mockPages(t, [
    page({ status: { more: "true", token: "next" } }),
    page({ items: `<ValueItems>${value("01/device/last")}</ValueItems>` }),
    page({ status: { more: "false" }, errors: "<ErrorResult><Id>000012345678901234567890</Id><Message>NOT_FOUND</Message></ErrorResult>" }),
  ]);
  const client = createEwsClient(clientConfig);
  const unknown = await client.getContainerItems("00/server/device");
  assert.equal(unknown.complete, null);
  assert.equal(unknown.status, null);
  assert.equal(unknown.pagesRead, 2);
  assert.equal(unknown.containers[0].valueItems[0].id, "01/device/last");
  const failedItem = await client.getContainerItems("00/server/device");
  assert.equal(failedItem.complete, false);
  assert.deepEqual(failedItem.errors, [{ id: "000012345678901234567890", message: "NOT_FOUND" }]);
});

test("container paging has a finite page limit without losing collected items", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, clientConfig.serviceUrl);
    assert.ok(options.body.includes("GetContainerItemsRequest"));
    calls += 1;
    assert.ok(calls <= 100, "Page limit must stop repeated server responses");
    return new Response(page({ items: `<ValueItems>${value(`01/device/${calls}`)}</ValueItems>`, status: { more: "true", token: `page-${calls}` } }), { status: 200 });
  });
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device");
  assert.equal(calls, 100);
  assert.equal(result.pagesRead, 100);
  assert.equal(result.complete, false);
  assert.equal(result.containers[0].valueItems.length, 100);
  assert.equal(result.errors[0].id, "00/server/device");
  assert.match(result.errors[0].message, /limit|100|pages/i);
});

test("container timeout after a page returns partial data instead of hanging or discarding it", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, clientConfig.serviceUrl);
    calls += 1;
    if (calls === 1) return new Response(page({ items: `<ValueItems>${value("01/device/one")}</ValueItems>`, status: { more: "true", token: "next" } }), { status: 200 });
    assert.ok(options.signal, "Container requests need a bounded timeout");
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  // A mocked fetch does not keep the event loop alive while AbortSignal.timeout is unref'ed.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const result = await createEwsClient({ ...clientConfig, containerTimeoutMs: 30 }).getContainerItems("00/server/device");
  assert.equal(calls, 2);
  assert.equal(result.complete, false);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.containers[0].valueItems[0].id, "01/device/one");
  assert.equal(result.errors[0].id, "00/server/device");
  assert.match(result.errors[0].message, /timed?\s*out|timeout|abort/i);
});

test("a timeout before any container page is returned rejects with gateway timeout status", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, clientConfig.serviceUrl);
    calls += 1;
    assert.ok(options.body.includes("GetContainerItemsRequest"));
    assert.ok(options.signal);
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  await assert.rejects(createEwsClient({ ...clientConfig, containerTimeoutMs: 30 }).getContainerItems("00/server/device"), (error) => error.status === 504 && /timed?\s*out|timeout/i.test(error.message));
  assert.equal(calls, 1);
});

test("an invalid paging flag retains readable items and reports incomplete discovery", async (t) => {
  const requests = mockPages(t, [page({ items: `<ValueItems>${value("01/device/readable")}</ValueItems>`, status: { more: "maybe", token: "unsafe-next" } })]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device");
  assert.equal(requests.length, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.complete, false);
  assert.equal(result.containers[0].valueItems[0].id, "01/device/readable");
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0].message, /invalid|flag|MoreDataAvailable/i);
});

test("single-page resumes still warn when the advertised continuation repeats the starting token", async (t) => {
  const requests = mockPages(t, [page({ items: `<ValueItems>${value("01/device/readable")}</ValueItems>`, status: { more: "true", token: "same" } })]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device", { allPages: false, moreDataRef: "same" });
  assert.equal(requests.length, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.complete, false);
  assert.equal(result.containers[0].valueItems[0].id, "01/device/readable");
  assert.equal(result.errors[0].id, "00/server/device");
  assert.match(result.errors[0].message, /repeat|token|continuation/i);
});

test("an oversized page strictly bounds all collected items and prevents unsafe continuation after truncation", async (t) => {
  const values = Array.from({ length: 50_000 }, (_, index) => `<ValueItem><Id>01/device/${index}</Id><Name>Point ${index}</Name><Type>Double</Type></ValueItem>`).join("");
  const requests = mockPages(t, [page({ items: `<ValueItems>${values}</ValueItems><HistoryItems><HistoryItem><Id>02/device/log</Id><Name>History</Name></HistoryItem></HistoryItems>`, status: { more: "true", token: "unsafe-next" } })]);
  const result = await createEwsClient(clientConfig).getContainerItems("00/server/device");
  const count = result.containers.reduce((total, container) => total + 1 + container.containerItems.length + container.valueItems.length + container.historyItems.length + container.alarmItems.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(count, 50_000);
  assert.equal(result.complete, false);
  assert.equal(result.status.moreDataRef, null);
  assert.ok(result.containers[0].valueItems.length > 0);
  assert.equal(result.errors[0].id, "00/server/device");
  assert.match(result.errors[0].message, /limit|50000|50,000|items/i);
});
