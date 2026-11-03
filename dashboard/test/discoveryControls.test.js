const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const grouping = require("../public/widgetGrouping");

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.textContent = "";
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  requestSubmit() { this.submitted = true; }
}

function setup({ editable = true, canAdd = true } = {}) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  node("#discovery-item-template").content = {
    cloneNode() {
      const parts = new Map();
      return { querySelector(selector) {
        if (!parts.has(selector)) parts.set(selector, new Element());
        return parts.get(selector);
      } };
    },
  };
  const requests = [];
  const context = vm.createContext({
    document: { querySelector: node, createElement: () => new Element() },
    IoTWidgetGrouping: grouping,
    fetch: (url, options) => {
      if (url === "/api/config") return new Promise(() => {});
      requests.push({ url, body: JSON.parse(options.body) });
      return Promise.resolve({ ok: true, status: 202, json: async () => ({ state: "running" }) });
    },
    fixtureEditable: editable,
    fixturePayload: { canAdd, items: [{ id: "00/Floor & room", name: "Floor", kind: "container" }] },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8"), context);
  const run = (source) => vm.runInContext(source, context);
  run("widgetEditingEnabled = fixtureEditable; renderDiscoveryItems(fixturePayload);");
  return { node, requests, run, scan: run("Array.from(discoveryContainerButtons)[0]") };
}

test("container discovery button submits its ID while the original button still starts from root", async () => {
  const { node, scan, requests, run } = setup();
  assert.equal(scan.textContent, "Automatski dodaj iz ove mape");
  const open = node("#discovery-results").children[0].querySelector(".discovery-action");
  assert.equal(open.textContent, "Otvori");
  open.dispatch("click");
  assert.equal(node("#discovery-query").value, "00/Floor & room");
  assert.equal(node("#discovery-form").submitted, true);

  await scan.dispatch("click");
  assert.deepEqual(requests, [{ url: "/api/discovery/auto", body: { containerId: "00/Floor & room" } }]);
  assert.equal(scan.disabled, true);
  assert.equal(node("#discovery-auto").disabled, true);
  assert.match(node("#discovery-auto-status").textContent, /Početna mapa: 00\/Floor & room/);
  await scan.dispatch("click");
  assert.equal(requests.length, 1);

  run('showAutomaticDiscovery({ state: "done", containerId: "00/Floor & room", added: 2, skipped: 1, containers: 2 });');
  assert.equal(scan.disabled, false);
  assert.match(node("#discovery-auto-status").textContent, /Dodano: 2/);
  await node("#discovery-auto").dispatch("click");
  assert.equal(requests[1].body.containerId, "");
});

test("container scan buttons follow bulk-operation locks and recover after errors", async () => {
  const { scan, requests, run } = setup();
  run("setWidgetClearBusy(true)");
  assert.equal(scan.disabled, true);
  await scan.dispatch("click");
  assert.equal(requests.length, 0);
  run("setWidgetClearBusy(false)");
  assert.equal(scan.disabled, false);
  run('showAutomaticDiscovery({ state: "running", containers: 0, found: 0, pending: 1 }); renderDiscoveryItems(fixturePayload);');
  assert.equal(run("Array.from(discoveryContainerButtons)[0].disabled"), true);
  run('showAutomaticDiscovery({ state: "error", error: "Unavailable" });');
  assert.equal(run("Array.from(discoveryContainerButtons)[0].disabled"), false);
});

test("browse-only discovery keeps container navigation without offering automatic additions", () => {
  for (const options of [{ editable: false }, { canAdd: false }]) {
    const { scan, node } = setup(options);
    assert.equal(scan, undefined);
    const open = node("#discovery-results").children[0].querySelector(".discovery-action");
    assert.equal(open.textContent, "Otvori");
    assert.equal(open.disabled, false);
  }
});
