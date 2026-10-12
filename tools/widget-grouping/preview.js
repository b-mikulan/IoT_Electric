const fs = require("node:fs");
const path = require("node:path");
const { parseWidgets } = require("../../dashboard/lib/config");
const { describeWidgetGroup } = require("../../dashboard/public/widgetGrouping");

function extractWidgets(data) {
  if (Array.isArray(data)) return data;
  if (!Array.isArray(data?.records)) throw new Error("Input must be a widget array or a saved EWS container-tree report.");
  const points = new Map();
  for (const record of data.records) {
    for (const container of record.data?.containers || []) {
      for (const item of container.valueItems || []) {
        if (!points.has(item.id)) points.set(item.id, {
          id: item.id, label: item.name, description: item.description, unit: item.unit,
          writable: false,
        });
      }
    }
  }
  return [...points.values()];
}

function buildPreview(rawWidgets) {
  const widgets = parseWidgets(JSON.stringify(rawWidgets), false);
  const groups = new Map();
  const oldGroups = new Set();
  for (const widget of widgets) {
    const heading = describeWidgetGroup(widget);
    if (!groups.has(heading.key)) groups.set(heading.key, { ...heading, widgets: [] });
    groups.get(heading.key).widgets.push(widget);
  }
  for (const widget of rawWidgets) {
    const id = String(widget.id).trim();
    oldGroups.add(typeof widget.group === "string" && widget.group.trim()
      ? widget.group.trim() : id.lastIndexOf("/") > 0 ? id.slice(0, id.lastIndexOf("/")) : "PLC vrijednosti");
  }
  const sorted = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "hr") || a.key.localeCompare(b.key, "hr"));
  return {
    summary: {
      widgets: widgets.length,
      groups: sorted.length,
      previousFolderGroups: oldGroups.size,
      deviceGroups: sorted.filter((g) => g.kind === "device").length,
      zoneGroups: sorted.filter((g) => g.kind === "zone").length,
      otherGroups: sorted.filter((g) => g.kind !== "device" && g.kind !== "zone").length,
    },
    groups: sorted,
  };
}

function renderPreview(preview) {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const groups = preview.groups.map((group) => `<details class="group">
    <summary><div><h2>${escape(group.label)}</h2><p>${escape(group.context || "Ručna ili postojeća grupa")}</p></div><span>${group.widgets.length} točaka</span></summary>
    <div class="points">${group.widgets.map((widget) => `<article><h3>${escape(widget.label)}</h3><p>${escape(widget.description)}</p><small>${escape(widget.unit || "Bez jedinice")}${widget.visible === false ? " · skriven widget" : ""}</small><code>${escape(widget.id)}</code></article>`).join("")}</div>
  </details>`).join("");
  return `<!doctype html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IoT Electric · Grupiranje po uređajima</title>
  <style>*{box-sizing:border-box}body{margin:0;background:#f3f7f6;color:#183b37;font:16px system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:36px 20px}header{margin-bottom:30px}h1{font-size:30px;margin:10px 0}header p{max-width:800px;line-height:1.6;color:#506c67}.badge{display:inline-block;background:#d9eeea;border-radius:20px;padding:6px 12px;font-size:13px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.stat{background:#fff;border:1px solid #d5e3df;border-radius:12px;padding:16px 22px}.stat strong{display:block;font-size:25px}.stat span{color:#506c67;font-size:13px}.group{background:#fff;border:1px solid #d5e3df;border-radius:14px;margin-bottom:12px;overflow:hidden}summary{display:flex;align-items:center;gap:16px;padding:18px 22px;cursor:pointer}summary:before{content:'▸';color:#00796b}.group[open] summary:before{content:'▾'}summary div{flex:1}h2{font-size:18px;margin:0}summary p{font-size:13px;color:#506c67;margin:5px 0 0}summary span{font-size:13px;white-space:nowrap;color:#506c67}.points{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:12px;padding:0 20px 20px}article{border:1px solid #e0e9e6;border-radius:10px;padding:15px;min-width:0}h3{font-size:15px;margin:0 0 8px}article p{font-size:13px;line-height:1.5;margin:0 0 8px;color:#506c67}small{display:block;color:#506c67}code{display:block;overflow-wrap:anywhere;font-size:10px;line-height:1.6;background:#f4f7f6;border-radius:5px;padding:7px;margin-top:12px}footer{font-size:13px;color:#506c67;line-height:1.6;margin-top:24px}</style></head><body><main>
  <header><span class="badge">Lokalni pregled spremljenih podataka</span><h1>Widgeti grupirani po uređaju</h1><p>Svaka cjelina okuplja svoje vrijednosti i tehnička svojstva. Klikni na grupu za pregled točaka. Uređaji istog imena na različitim kontrolerima prikazani su odvojeno.</p></header>
  <div class="stats"><div class="stat"><strong>${preview.summary.widgets}</strong><span>točaka</span></div><div class="stat"><strong>${preview.summary.previousFolderGroups} → ${preview.summary.groups}</strong><span>grupa prije i nakon grupiranja</span></div><div class="stat"><strong>${preview.summary.deviceGroups}</strong><span>grupa prema uređaju</span></div><div class="stat"><strong>${preview.summary.zoneGroups}</strong><span>zonskih grupa</span></div></div>
  ${groups}<footer>Pregled uključuje i reference na postojeće vrijednosti, vanjske veze i dijagnostiku; broj točaka nije broj uređaja. Ovdje se provjerava grupiranje. Odabir najvažnijih funkcija dolazi u sljedećem koraku. Ovaj pregled ne kontaktira kontroler i nema naredbe za upravljanje.</footer></main></body></html>`;
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error("Usage: npm run widgets:group-preview -- input.json [output-directory]");
    const input = path.resolve(process.argv[2]);
    const output = path.resolve(process.argv[3] || path.join("output", "widget-grouping"));
    const preview = buildPreview(extractWidgets(JSON.parse(fs.readFileSync(input, "utf8").replace(/^\uFEFF/, ""))));
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "grouping-preview.json"), JSON.stringify(preview, null, 2) + "\n");
    fs.writeFileSync(path.join(output, "grouping-preview.html"), renderPreview(preview));
    console.log(JSON.stringify({ ...preview.summary, output }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { extractWidgets, buildPreview, renderPreview };
