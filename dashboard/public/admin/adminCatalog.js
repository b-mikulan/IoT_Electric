(function () {
  "use strict";
  const { request } = globalThis.IoTAdmin;
  const get = name => document.getElementById(`catalog-${name}`);
  const states = { starting: "Priprema", running: "Skeniranje", stopping: "Pauziranje", indexing: "Spremanje kataloga", paused: "Pauzirano", interrupted: "Prekinuto", partial: "Potrebna provjera", failed: "Greška", completed: "Završeno" };
  let data = { jobs: [], enabled: false, busy: false }, selected = "", busy = false, refreshing = false, offset = 0, search = "", browserKey = "", deviceRequest = 0;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const job = () => data.jobs.find(item => item.id === selected);
  function status(message, error = false) {
    get("status").textContent = message;
    get("status").classList.toggle("is-error", error);
  }
  function controls() {
    const confirmed = get("confirm").checked;
    get("start").disabled = busy || data.busy || !data.enabled || !confirmed;
    get("resume").disabled = busy || data.busy || !data.enabled || !confirmed || !job()?.canResume;
    const active = data.jobs.find(item => item.id === data.activeId);
    get("pause").disabled = busy || !data.busy || ["stopping", "indexing"].includes(active?.state);
    for (const name of ["root", "profile", "limit", "confirm", "retry"]) get(name).disabled = busy || data.busy;
    get("job").disabled = busy;
  }
  async function devices() {
    const current = job(), version = ++deviceRequest;
    get("devices").replaceChildren();
    get("prev").disabled = get("next").disabled = true;
    get("devices-status").textContent = "Učitavam uređaje…";
    try {
      const page = await request(`/api/admin/catalog/${current.id}/devices?search=${encodeURIComponent(search)}&offset=${offset}`);
      if (version !== deviceRequest || selected !== current.id) return;
      get("devices-status").textContent = page.total ? `Prikaz ${offset + 1}–${offset + page.items.length} od ${page.total} uređaja.` : "Nema uređaja za odabranu pretragu.";
      for (const device of page.items) {
        const row = node("article", undefined, "organization-item");
        row.append(node("strong", device.label || device.key), node("p", `${device.type} · ${device.room_label || "Bez prepoznate prostorije"}`, "admin-hint"), node("code", device.key));
        get("devices").append(row);
      }
      get("prev").disabled = offset === 0;
      get("next").disabled = offset + page.items.length >= page.total;
    } catch (error) { if (version === deviceRequest) get("devices-status").textContent = error.message; }
  }
  function render() {
    get("history").hidden = !data.jobs.length;
    const options = data.jobs.map(item => {
      const option = node("option", `${new Date(item.createdAt).toLocaleString("hr-HR")} · ${states[item.state] || item.state}`);
      option.value = item.id; return option;
    });
    get("job").replaceChildren(...options);
    if (!job()) selected = data.activeId || data.jobs[0]?.id || "";
    get("job").value = selected;
    const current = job();
    controls();
    if (!current) return;
    get("message").textContent = `${states[current.state] || current.state}: ${current.message}`;
    get("scope").textContent = `${current.profile === "full" ? "Sve dostupne grane" : "Uređaji i točke"} · ${current.root || "Cijela dostupna zgrada"}`;
    const summary = current.summary || {}, counts = summary.states || {};
    const pairs = [["Zahtjevi u ovom pokretanju", `${current.requests || 0}${current.maxRequests ? ` / ${current.maxRequests}` : ""}`], ["Spremljene stranice", summary.pages || 0], ["Grane na čekanju", counts.pending || 0], ["Greške / nepotpune grane", (counts.error || 0) + (counts.partial || 0) + (counts.unknown || 0)], ["Preskočene grane", counts.pruned || 0]];
    if (current.catalog) pairs.push(["Uređaji u katalogu", current.catalog.devices], ["Točke u katalogu", current.catalog.points]);
    get("counts").replaceChildren(...pairs.map(([label, value]) => { const div = node("div"); div.append(node("dt", label), node("dd", String(value))); return div; }));
    get("coverage").textContent = summary.completenessConfirmed ? "Potpunost dostupnog obuhvata je potvrđena." : "Ukupan broj grana unaprijed nije poznat. Potpunost cijele zgrade nije potvrđena; provjeri preskočene i neuspjele grane.";
    get("downloads").replaceChildren(...(current.files || []).map(file => {
      const link = node("a", `Preuzmi ${file}`, "admin-text-button");
      link.href = `/api/admin/catalog/${current.id}/files/${encodeURIComponent(file)}`; return link;
    }));
    const browsable = Boolean(current.catalog) && current.id !== data.activeId;
    get("browser").hidden = !browsable;
    const key = browsable ? `${current.id}:${current.catalog.snapshotId}` : "";
    if (key !== browserKey) {
      browserKey = key; ++deviceRequest; offset = 0;
      if (browsable) void devices();
    }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      data = await request("/api/admin/catalog/status");
      render();
      status(!data.enabled ? "Skeniranje nije dostupno u demo načinu ili bez backend vjerodajnica." : data.busy ? "Skeniranje je aktivno. Očitanja i upravljanje su privremeno pauzirani." : "Spremno. Odaberi novi sken ili nastavi spremljeni napredak.");
    } catch (error) { status(error.message, true); }
    finally { refreshing = false; }
  }
  async function action(kind) {
    if (busy) return;
    busy = true; controls();
    try {
      const body = kind === "pause" ? { id: data.activeId } : {
        confirmPause: get("confirm").checked, maxRequests: Number(get("limit").value),
        ...(kind === "resume" ? { resumeId: selected, retryFailed: get("retry").checked } : { root: get("root").value, profile: get("profile").value }),
      };
      const result = await request(`/api/admin/catalog/${kind === "pause" ? "pause" : "start"}`, body);
      selected = result.id; get("confirm").checked = false;
      await refresh();
    } catch (error) { status(error.message, true); }
    finally { busy = false; controls(); }
  }
  for (const kind of ["start", "pause", "resume"]) get(kind).addEventListener("click", () => void action(kind));
  get("refresh").addEventListener("click", () => void refresh());
  get("confirm").addEventListener("change", controls);
  get("job").addEventListener("change", () => { selected = get("job").value; render(); });
  get("search-form").addEventListener("submit", event => { event.preventDefault(); search = get("search").value.trim(); offset = 0; void devices(); });
  get("prev").addEventListener("click", () => { offset = Math.max(0, offset - 50); void devices(); });
  get("next").addEventListener("click", () => { offset += 50; void devices(); });
  void refresh();
  setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy) void refresh(); });
}());
