"use strict";
const transferUi = Object.fromEntries(["file", "availability", "status", "preview", "counts", "warnings", "confirm", "import", "cancel", "filename", "success", "success-message"].map(name => [name, document.querySelector(`#transfer-${name}`)]));
let selectedDocument = null, previewToken = null, enabled = false, busy = false, selection = 0;
function message(text, error = false) { transferUi.status.textContent = text; transferUi.status.classList.toggle("is-error", error); }
function controls() { transferUi.import.disabled = !enabled || busy || !previewToken || !transferUi.confirm.checked; transferUi.file.disabled = !enabled || busy; transferUi.cancel.disabled = busy; transferUi.confirm.disabled = busy; }
function reset() { selectedDocument = null; previewToken = null; transferUi.preview.hidden = true; transferUi.confirm.checked = false; controls(); }
async function request(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Zahtjev nije uspio (${response.status}).`);
  return payload;
}
async function selectFile() {
  const current = ++selection;
  reset(); transferUi.success.hidden = true;
  const file = transferUi.file.files[0];
  if (!file) { message(""); return; }
  if (file.size > 16 * 1024 * 1024) { message("Datoteka je prevelika. Najveća veličina je 16 MB.", true); return; }
  busy = true; controls(); message("Provjeravam datoteku…");
  try {
    let document;
    try { document = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
    catch { throw new Error("Datoteka nije valjan JSON. Odaberi dashboard-backup.json ili widgets.json."); }
    const payload = await request("/api/dashboard-transfer/preview", { document });
    if (current !== selection) return;
    selectedDocument = document; previewToken = payload.token;
    transferUi.counts.replaceChildren();
    for (const [label, count] of [["Pointova", payload.summary.points], ["Kartica uređaja", payload.summary.devices], ["Prostorija", payload.summary.rooms], ["Točaka s upisom", payload.summary.writablePoints]]) {
      const row = window.document.createElement("div"), name = window.document.createElement("dt"), value = window.document.createElement("dd");
      name.textContent = label; value.textContent = count.toLocaleString("hr-HR"); row.append(name, value); transferUi.counts.append(row);
    }
    transferUi.warnings.replaceChildren();
    for (const warning of payload.summary.warnings) { const item = window.document.createElement("li"); item.textContent = warning; transferUi.warnings.append(item); }
    transferUi.warnings.hidden = !payload.summary.warnings.length;
    transferUi.filename.textContent = `${file.name} · novih pointova: ${payload.summary.added.toLocaleString("hr-HR")} · uklanja se: ${payload.summary.removed.toLocaleString("hr-HR")}`;
    transferUi.preview.hidden = false; message("Datoteka je spremna. Pregledaj sadržaj prije uvoza.");
  } catch (error) { if (current === selection) { reset(); message(error.message, true); } }
  finally { if (current === selection) { busy = false; controls(); } }
}
transferUi.file.addEventListener("change", () => void selectFile());
transferUi.confirm.addEventListener("change", controls);
transferUi.cancel.addEventListener("click", () => { ++selection; reset(); transferUi.file.value = ""; message(""); });
transferUi.import.addEventListener("click", async () => {
  if (!enabled || busy || !previewToken || !transferUi.confirm.checked) return;
  busy = true; controls(); message("Spremam sigurnosnu kopiju i uvozim postavke…");
  try {
    const result = await request("/api/dashboard-transfer/import", { document: selectedDocument, token: previewToken });
    reset(); transferUi.success.hidden = false;
    transferUi["success-message"].textContent = `Uvezeno je ${result.summary.points.toLocaleString("hr-HR")} pointova i ${result.summary.devices.toLocaleString("hr-HR")} kartica uređaja. Sigurnosna kopija: ${result.backupId}.`;
    message(""); transferUi.file.value = "";
  } catch (error) { reset(); message(`${error.message} Ponovno odaberi datoteku za novi pregled.`, true); }
  finally { busy = false; controls(); }
});
async function initialize() {
  controls();
  try {
    const response = await fetch("/api/dashboard-transfer/status", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const status = await response.json(); enabled = status.enabled === true;
    if (!enabled) { transferUi.availability.textContent = "Uvoz zahtijeva stvarni način rada (DEMO_MODE=false) i trajnu datoteku WIDGETS_FILE. Izvoz je i dalje dostupan."; transferUi.availability.hidden = false; }
  } catch { message("Ne mogu provjeriti je li uvoz dostupan. Osvježi stranicu.", true); }
  controls();
}
void initialize();
