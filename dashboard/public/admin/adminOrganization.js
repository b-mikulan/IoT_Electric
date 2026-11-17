(function () {
  "use strict";
  const { request, matches } = globalThis.IoTAdmin;
  const get = name => document.getElementById(`organization-${name}`);
  const selected = new Set();
  let proposal = null, busy = false, limit = 50;
  const scope = () => ({ root: get("root").value.trim(), roomId: get("room").value });
  function status(message, error = false) {
    get("status").textContent = message;
    get("status").classList.toggle("is-error", error);
  }
  function selectionChanged() {
    get("selected").textContent = `Odabrano promjena: ${selected.size}`;
    get("apply").disabled = busy || !proposal || !selected.size || !get("confirm").checked;
  }
  function setBusy(value) {
    busy = value;
    for (const name of ["preview", "root", "room", "select", "clear", "confirm"]) get(name).disabled = value;
    get("result").inert = value;
    selectionChanged();
  }
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const accessLabel = value => value.write ? "čitanje i upravljanje" : value.read ? "čitanje" : "bez pristupa";
  function render() {
    const items = proposal.suggestions.filter(item => matches([item.label, item.key, item.from, item.to, item.reason].join(" "), get("search").value));
    const list = get("items");
    list.replaceChildren();
    for (const item of items.slice(0, limit)) {
      const row = node("div", undefined, "organization-item");
      const label = node("label", undefined, "admin-checkbox");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(item.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(item.id); else selected.delete(item.id);
        get("confirm").checked = false;
        selectionChanged();
      });
      label.append(checkbox, node("strong", item.label));
      row.append(label, node("p", `${item.kind === "room" ? "Prostorija" : "Prikaz u kartici"}: ${item.from} → ${item.to}`),
        node("p", item.reason, "admin-hint"), node("code", item.key));
      if (item.review) row.append(node("p", "Potrebna pojedinačna potvrda", "organization-review"));
      if (item.permissions.length) {
        const details = node("ul");
        for (const impact of item.permissions) details.append(node("li", `${impact.username}: ${accessLabel(impact.before)} → ${accessLabel(impact.after)}`));
        row.append(details);
      }
      list.append(row);
    }
    if (!items.length) list.append(node("p", proposal.suggestions.length ? "Nema prijedloga za ovu pretragu." : "Nema novih promjena koje možemo predložiti iz ovih podataka.", "admin-hint"));
    get("more").hidden = items.length <= limit;
    selectionChanged();
  }
  function invalidate() {
    proposal = null; selected.clear(); get("confirm").checked = false; get("result").hidden = true;
    status("Odabir je promijenjen. Ponovno pripremi prijedlog.");
    selectionChanged();
  }
  get("root").addEventListener("input", invalidate);
  get("room").addEventListener("change", invalidate);
  get("preview").addEventListener("click", async () => {
    setBusy(true); status("Pripremam prijedlog iz spremljenih podataka…");
    proposal = null; selected.clear(); get("result").hidden = true; get("confirm").checked = false;
    try {
      const requestedScope = scope();
      proposal = await request("/api/admin/organization/preview", { scope: requestedScope });
      const room = get("room");
      room.replaceChildren(new Option("Bez dodjele grane", ""), ...proposal.rooms.map(entry => new Option(entry.caption, entry.id)));
      room.value = requestedScope.roomId;
      get("branches").replaceChildren(...proposal.branches.map(branch => new Option(branch, branch)));
      get("scope").hidden = false;
      const { devices, protectedRooms, grouped, roomsWithoutFloor } = proposal.summary;
      const captured = proposal.source.capturedAt ? ` Snimka kataloga: ${new Date(proposal.source.capturedAt).toLocaleString("hr-HR")}.` : "";
      get("summary").textContent = `${devices} uređaja · ${protectedRooms} ručnih dodjela sačuvano · ${grouped} već podgrupirano · ${roomsWithoutFloor} prostorija bez kata.${captured}`;
      get("unresolved-title").textContent = `Potrebna provjera (${proposal.unresolved.length})`;
      get("unresolved").hidden = !proposal.unresolved.length;
      get("unresolved-items").replaceChildren(...proposal.unresolved.slice(0, 100).map(item => node("li", `${item.label} — ${item.reason} (${item.key})`)));
      if (proposal.unresolved.length > 100) get("unresolved-items").append(node("li", "Prikazano prvih 100 stavki. Za razvrstavanje odaberi pojedinu granu ili otvori postavke kartica na dashboardu."));
      get("search").value = ""; limit = 50; render(); get("result").hidden = false;
      status(proposal.source.hasMetadata ? "Prijedlog je spreman. Odaberi promjene koje želiš primijeniti." : "Spremljeni opisi kataloga nisu dostupni. Prijedlog koristi postojeće uređaje i postavke; možeš odabrati granu i prostoriju.");
    } catch (error) { proposal = null; status(error.message, true); }
    finally { setBusy(false); }
  });
  get("select").addEventListener("click", () => {
    for (const item of proposal.suggestions) if (!item.review) selected.add(item.id);
    get("confirm").checked = false; render();
  });
  get("clear").addEventListener("click", () => { selected.clear(); get("confirm").checked = false; render(); });
  get("confirm").addEventListener("change", selectionChanged);
  get("search").addEventListener("input", () => { limit = 50; render(); });
  get("more").addEventListener("click", () => { limit += 50; render(); });
  get("apply").addEventListener("click", async () => {
    if (!proposal || busy || !selected.size || !get("confirm").checked) return;
    setBusy(true); status("Spremam sigurnosnu kopiju i odabrane promjene…");
    try {
      const result = await request("/api/admin/organization/apply", { token: proposal.token, scope: proposal.scope, selectedIds: [...selected] });
      get("backup-link").href = result.backupUrl; get("backup").hidden = false;
      status(`Spremljeno promjena: ${result.count}. Prethodna konfiguracija dostupna je za preuzimanje.`);
      document.dispatchEvent(new CustomEvent("organization-applied"));
    } catch (error) { status(`${error.message} Pripremi novi prijedlog prije sljedećeg pokušaja.`, true); }
    finally { proposal = null; selected.clear(); get("result").hidden = true; get("confirm").checked = false; setBusy(false); }
  });
})();
