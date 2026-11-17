const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createApp } = require("../app");
const { composePage, renderSections } = require("../lib/http/pageTemplates");

const flags = (...names) => new Set(names);

test("a section is kept only when the including page sets its flag", () => {
  const source = '<button class="btn{{#appTheme}} filled{{/appTheme}}">';
  assert.equal(renderSections(source, flags("appTheme")), '<button class="btn filled">');
  assert.equal(renderSections(source, flags()), '<button class="btn">');
});

test("an inverted section is kept only when the flag is absent", () => {
  const source = "{{#appTheme}}themed{{/appTheme}}{{^appTheme}}classic{{/appTheme}}";
  assert.equal(renderSections(source, flags("appTheme")), "themed");
  assert.equal(renderSections(source, flags()), "classic");
});

test("markers and notes alone on a line leave no blank line behind", () => {
  const source = "{{! Shared markup. }}\n<div>\n  {{#wrap}}\n  <section>\n  {{/wrap}}\n  text\n</div>\n";
  assert.equal(renderSections(source, flags("wrap")), "<div>\n  <section>\n  text\n</div>\n");
  assert.equal(renderSections(source, flags()), "<div>\n  text\n</div>\n");
});

test("a Windows checkout with CRLF line endings composes without stray lines", () => {
  const partial = "{{! Note. }}\r\n  {{#wrap}}\r\n  <section>\r\n  {{/wrap}}\r\n  text\r\n";
  assert.equal(composePage("<main>\r\n  {{> part wrap}}\r\n</main>\r\n", () => partial), "<main>\r\n  <section>\r\n  text\r\n</main>\r\n");
  assert.equal(composePage("<main>\r\n  {{> part}}\r\n</main>\r\n", () => partial), "<main>\r\n  text\r\n</main>\r\n");
});

test("an include line is replaced by the partial rendered with the flags it lists", () => {
  const partials = { dialogs: '<dialog class="{{#appTheme}}themed{{/appTheme}}{{^appTheme}}classic{{/appTheme}}"></dialog>\n' };
  const read = (name) => partials[name];
  assert.equal(composePage("<main></main>\n    {{> dialogs appTheme}}\n<footer></footer>\n", read), '<main></main>\n<dialog class="themed"></dialog>\n<footer></footer>\n');
  assert.equal(composePage("<main></main>\n    {{> dialogs}}\n<footer></footer>\n", read), '<main></main>\n<dialog class="classic"></dialog>\n<footer></footer>\n');
});

test("a page that includes a missing partial is rejected", () => {
  assert.throws(() => composePage("{{> dialogs}}\n", () => undefined), /dialogs/);
});

test("an unclosed or misplaced marker is rejected instead of reaching the browser", () => {
  const read = (name) => ({ open: "{{#appTheme}}never closed\n", stray: "text{{/appTheme}}\n", plain: "text\n" })[name];
  assert.throws(() => composePage("{{> open}}\n", read), /\{\{#appTheme\}\}/);
  assert.throws(() => composePage("{{> stray}}\n", read), /\{\{\/appTheme\}\}/);
  assert.throws(() => composePage("<p>{{> plain}}</p>\n", read), /\{\{> plain\}\}/);
});

async function serve(t) {
  const poller = new EventEmitter();
  poller.getSnapshot = () => ({ widgets: [], status: "connected" });
  poller.writeValue = () => { throw new Error("Unexpected controller write"); };
  const app = createApp({ poller, config: { demoMode: true, widgets: [], intervalMs: 1000 }, deviceMetadata: { read() { throw new Error("Demo must not contact middleware"); } } });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const sharedIds = [
  "discovery-dialog", "visibility-dialog", "group-clear-dialog", "group-rename-dialog",
  "device-settings-dialog", "rooms-dialog", "device-room-dialog", "settings-dialog",
  "discovery-item-template", "visibility-item-template",
];
const count = (text, part) => text.split(part).length - 1;

test("both dashboard pages are served with each shared dialog once and no template markers", async (t) => {
  const base = await serve(t);
  for (const url of ["/", "/index.html", "/technical.html"]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get("cache-control"), "public, max-age=0", url);
    const html = await response.text();
    for (const id of sharedIds) assert.equal(count(html, `id="${id}"`), 1, `${url} ${id}`);
    assert.equal(html.includes("{{"), false, url);
  }
});

test("an encoded or doubled-slash spelling of a page URL is composed like the page itself", async (t) => {
  const base = await serve(t);
  for (const url of ["/%69ndex.html", "//index.html", "/technical%2Ehtml"]) {
    const html = await (await fetch(base + url)).text();
    assert.equal(count(html, 'id="rooms-dialog"'), 1, url);
    assert.equal(html.includes("{{"), false, url);
  }
});

test("shared dialogs keep the styling of the page that includes them", async (t) => {
  const base = await serve(t);
  const main = await (await fetch(`${base}/`)).text();
  const technical = await (await fetch(`${base}/technical.html`)).text();
  assert.match(main, /<button id="rooms-create" class="btn filled" type="submit">/);
  assert.match(main, /<details class="floor-management collapsible app-disclosure" id="floors-management">/);
  assert.match(technical, /<button id="rooms-create" class="btn" type="submit">/);
  assert.match(technical, /<details class="floor-management" id="floors-management">/);
  // Materialize keeps .collapsible-body closed unless dashboardTheme.css,
  // which the technical page does not load, overrides it.
  assert.doesNotMatch(technical, /collapsible-body/);
});
