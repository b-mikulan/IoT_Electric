const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const tick = () => new Promise(resolve => setImmediate(resolve));

function adminUi() {
  const nodes = new Map();
  let activeElement = null;
  class Element {
    constructor(tag = "div") {
      this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {};
      this.value = ""; this.checked = false; this.hidden = false; this.disabled = false;
      this.classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    dispatchEvent(event) { for (const callback of this.listeners[event.type] || []) callback(event); }
    emit(type, props = {}) { this.dispatchEvent({ type, preventDefault() {}, ...props }); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) {
      if (this.contains(activeElement)) activeElement = null;
      this.children = children;
    }
    contains(node) { return this === node || this.children.some(child => child instanceof Element && child.contains(node)); }
    setAttribute() {}
    focus() { activeElement = this; }
    reportValidity() { return true; }
    querySelectorAll() {
      return this.children.flatMap(child => child instanceof Element ? [child, ...child.querySelectorAll()] : [])
        .filter(child => ["input", "select", "button"].includes(child.tag));
    }
  }
  const source = fs.readFileSync(path.join(__dirname, "../lib/http/adminPage.js"), "utf8");
  for (const match of source.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[2], new Element(match[1]));
  const el = id => nodes.get(`admin-${id}`);
  el("user-form").append(...["username", "password", "all-rooms", "room-field", "room-search", "room-floor", "selected-only", "select-visible", "clear-visible", "rooms", "save", "reset", "delete", "revoke"].map(el));
  const document = new Element();
  document.getElementById = id => nodes.get(id);
  document.createElement = tag => new Element(tag);
  Object.defineProperty(document, "activeElement", { get: () => activeElement });
  const window = new Element();
  window.confirm = () => true;
  const context = vm.createContext({ document, window, Option: class extends Element {
    constructor(text, value) { super("option"); this.textContent = text; this.value = value; }
  }, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/admin/adminApi.js"), "utf8"), context);
  let failSave = false;
  const requests = [];
  const rooms = [
    { id: "a", name: "Čitaonica", floor: "Prizemlje" },
    { id: "b", name: "Ured 101", floor: "1. kat" },
    { id: "c", name: "Ured 201", floor: "2. kat" },
  ];
  context.IoTAdmin.request = async (url, body) => {
    if (!body) return { users: [{ username: "Ana", roomIds: ["a"] }], rooms };
    requests.push({ url, body: JSON.parse(JSON.stringify(body)) });
    if (url.endsWith("/revoke")) return { revoked: 1 };
    if (failSave) throw new Error("Spremanje nije uspjelo.");
    return { user: { username: body.username, roomIds: body.roomIds } };
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/admin/adminUsers.js"), "utf8"), context);
  return { el, document, window, requests, failSave: () => { failSave = true; } };
}

test("room search and floor bulk selection preserve grants hidden by filters", async () => {
  const { el, requests } = adminUi();
  await tick();
  el("room-search").value = "citaonica";
  el("room-search").emit("input");
  assert.equal(el("rooms").children.length, 1);
  assert.equal(el("rooms").children[0].children[0].checked, true);
  el("room-search").value = "Ured";
  el("room-search").emit("input");
  el("room-floor").value = JSON.stringify("1. kat");
  el("room-floor").emit("change");
  el("select-visible").emit("click");
  el("user-form").emit("submit");
  await tick();
  assert.deepEqual(requests.at(-1).body.roomIds, ["a", "b"]);
  el("room-floor").value = JSON.stringify("1. kat");
  el("room-floor").emit("change");
  el("clear-visible").emit("click");
  el("selected-only").checked = true;
  el("selected-only").emit("change");
  assert.equal(el("rooms").children.length, 0);
  el("user-form").emit("submit");
  await tick();
  assert.deepEqual(requests.at(-1).body.roomIds, ["a"]);
});

test("full access and no access are distinct; rejected saves retain the editor draft", async () => {
  const { el, requests, failSave } = adminUi();
  await tick();
  el("all-rooms").checked = true;
  el("all-rooms").emit("change");
  assert.equal(el("room-field").disabled, true);
  el("user-form").emit("submit");
  await tick();
  assert.equal(requests.at(-1).body.roomIds, null);
  el("all-rooms").checked = false;
  el("all-rooms").emit("change");
  el("user-form").emit("submit");
  await tick();
  assert.deepEqual(requests.at(-1).body.roomIds, []);
  failSave();
  el("username").value = "Novi naziv";
  el("password").value = "new-password";
  el("select-visible").emit("click");
  el("user-form").emit("submit");
  await tick();
  assert.equal(el("username").value, "Novi naziv");
  assert.equal(el("password").value, "new-password");
  assert.match(el("room-summary").textContent, /Odabrano 3/);
  assert.equal(el("status").classes.has("is-error"), true);
  assert.equal(el("save").disabled, false);
});

test("session refresh keeps keyboard focus and revocation preserves unsaved account changes", async () => {
  const { el, document, requests } = adminUi();
  await tick();
  el("users").children[0].focus();
  document.emit("admin-sessions-updated", { detail: { sessions: [{ username: "Ana", count: 1 }] } });
  assert.equal(document.activeElement, el("users").children[0]);
  assert.equal(el("revoke").disabled, false);
  el("username").value = "Unsaved name";
  el("revoke").emit("click");
  await tick();
  assert.deepEqual(requests.at(-1), { url: "/api/admin/users/revoke", body: { username: "Ana" } });
  assert.equal(el("username").value, "Unsaved name");
  assert.equal(el("revoke").disabled, true);
});
