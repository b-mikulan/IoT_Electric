(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const formatTime = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("hr-HR") : String(value || "—");
  const text = DataTable.render.text();
  const dateColumn = (data) => ({ data, render: (value, type) => type === "display" || type === "filter" ? text.display(formatTime(value)) : Date.parse(value) || 0 });
  const language = { emptyTable: "Nema podataka za prikaz", search: "Pretraži:", lengthMenu: "Prikaži _MENU_ redaka", info: "_START_–_END_ od _TOTAL_ redaka", infoEmpty: "0 redaka", infoFiltered: "(od ukupno _MAX_)", zeroRecords: "Nema rezultata pretrage", paginate: { first: "Prva", last: "Zadnja", next: "Sljedeća", previous: "Prethodna" } };
  const historyTable = new DataTable("#history-table", { language, pageLength: 10, order: [[0, "asc"]], columns: [dateColumn("timestamp"), { data: "value", defaultContent: "—", render: text }, { data: "state", defaultContent: "—", render: text }] });
  const alarmsTable = new DataTable("#alarms-table", { language, pageLength: 10, order: [[0, "desc"]], columns: [dateColumn("timestamp"), dateColumn("occurredAt"), ...["source", "message", "priority", "state", "type", "id", "sourceId"].map((data) => ({ data, defaultContent: "—", render: text }))] });
  const state = {
    history: { rows: [], query: null, cursor: null, seen: new Set(), busy: false, table: historyTable },
    alarms: { rows: [], query: {}, cursor: null, seen: new Set(), busy: false, table: alarmsTable },
  };
  let chart;
  function status(id, message, error = false) {
    $(id).textContent = message;
    $(id).classList.toggle("telemetry-error", error);
  }
  async function post(url, body) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Dohvat nije uspio.");
    return result;
  }
  function drawChart(rows, unit) {
    chart?.destroy();
    chart = null;
    const points = rows.map((row) => {
      const numeric = (typeof row.value === "number" || typeof row.value === "string" && row.value.trim() !== "") && Number.isFinite(Number(row.value));
      return { x: Date.parse(row.timestamp), y: numeric ? Number(row.value) : null };
    }).filter((point) => Number.isFinite(point.x)).sort((a, b) => a.x - b.x);
    const numericCount = points.filter((point) => point.y !== null).length;
    $("chart-wrap").hidden = numericCount === 0;
    $("chart-note").textContent = rows.length && numericCount < rows.length ? "Graf prikazuje samo brojčane vrijednosti s valjanim vremenom. Svi zapisi dostupni su u tablici." : "";
    if (!numericCount) return;
    chart = new Chart($("history-chart"), {
      type: "line", data: { datasets: [{ label: unit && unit !== "none" ? `Vrijednost (${unit})` : "Vrijednost", data: points, borderColor: "#00796b", borderWidth: 1.5, pointRadius: points.length > 200 ? 0 : 2, spanGaps: false }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        scales: { x: { type: "linear", ticks: { maxTicksLimit: 6, callback: (value) => formatTime(new Date(value).toISOString()) }, title: { display: true, text: "Vrijeme" } } },
        plugins: { tooltip: { callbacks: { title: (items) => items.length ? formatTime(new Date(items[0].parsed.x).toISOString()) : "" } } },
      },
    });
  }
  async function load(kind, append = false) {
    const current = state[kind];
    if (current.busy || append && !current.cursor) return;
    if (!append) {
      if (kind === "history") {
        const from = new Date($("time-from").value), to = new Date($("time-to").value);
        if (!$("history-id").value.trim() || !Number.isFinite(+from) || !Number.isFinite(+to) || from >= to) {
          status("history-status", "Odaberi trend i ispravan vremenski raspon (Od prije Do).", true); return;
        }
        current.query = { historyItemId: $("history-id").value.trim(), timeFrom: from.toISOString(), timeTo: to.toISOString() };
      }
      current.rows = []; current.cursor = null; current.seen.clear(); current.table.clear().draw();
      if (kind === "history") drawChart([], "");
    }
    current.busy = true;
    const controls = kind === "history" ? [...$("history-form").elements, $("history-more")] : [$("alarms-refresh"), $("alarms-more")];
    controls.forEach((element) => element.disabled = true);
    status(`${kind}-status`, "Dohvaćam podatke…");
    try {
      const result = await post(`/api/${kind}/query`, { ...current.query, ...(append ? { moreDataRef: current.cursor } : {}) });
      if (result.needsRefresh) {
        current.cursor = null;
        throw new Error("Lista alarma se promijenila tijekom dohvata. Pokreni novi dohvat alarma.");
      }
      const usedCursor = current.cursor;
      current.rows.push(...result.rows);
      current.table.rows.add(result.rows).draw(false);
      if (usedCursor) current.seen.add(usedCursor);
      current.cursor = result.moreDataAvailable ? result.moreDataRef : null;
      let suffix = current.cursor ? " Dostupno je još podataka — učitaj nastavak." : " Dohvat završen.";
      if (current.cursor && current.seen.has(current.cursor)) {
        current.cursor = null;
        suffix = " Kontroler je ponovio oznaku nastavka; pokreni novi dohvat za preostale podatke.";
      }
      if (kind === "history") drawChart(current.rows, result.unit);
      status(`${kind}-status`, `Dohvaćeno ${current.rows.length} ${kind === "history" ? "vrijednosti" : "alarma"}.${suffix}`);
    } catch (error) {
      status(`${kind}-status`, `${error.message} ${current.rows.length ? `Prikazano je ${current.rows.length} prethodno dohvaćenih redaka; dohvat nije potpun.` : ""}`, true);
    } finally {
      current.busy = false;
      controls.forEach((element) => element.disabled = false);
      $(`${kind}-more`).hidden = !current.cursor;
    }
  }
  async function browse() {
    const controls = [...$("browse-form").elements];
    controls.forEach((element) => element.disabled = true);
    $("browse-items").replaceChildren();
    status("browse-status", "Dohvaćam mape i trendove…");
    try {
      const result = await post("/api/history/browse", { containerId: $("container-id").value });
      for (const item of result.items) {
        const li = document.createElement("li"), button = document.createElement("button");
        button.type = "button";
        button.textContent = `${item.kind === "container" ? "Mapa" : "Trend"}: ${item.name} · ${item.id}`;
        button.addEventListener("click", () => {
          if (item.kind === "container") { $("container-id").value = item.id; void browse(); }
          else if (!state.history.busy) { $("history-id").value = item.id; $("history-id").focus(); }
        });
        li.append(button); $("browse-items").append(li);
      }
      status("browse-status", result.errors.length ? result.errors.map((error) => error.message).join("; ") : result.items.length ? "Otvori mapu ili odaberi trend." : "Ova mapa nema podmapa ni trendova.", result.errors.length > 0);
    } catch (error) { status("browse-status", error.message, true); }
    finally { controls.forEach((element) => element.disabled = false); }
  }
  const localInput = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("time-to").value = localInput(new Date());
  $("time-from").value = localInput(new Date(Date.now() - 86400000));
  $("timezone-note").textContent = `Vrijeme se unosi i prikazuje u zoni preglednika (${Intl.DateTimeFormat().resolvedOptions().timeZone}); kontroleru se šalje UTC.`;
  $("history-form").addEventListener("submit", (event) => { event.preventDefault(); void load("history"); });
  $("history-more").addEventListener("click", () => void load("history", true));
  $("alarms-refresh").addEventListener("click", () => void load("alarms"));
  $("alarms-more").addEventListener("click", () => void load("alarms", true));
  $("browse-form").addEventListener("submit", (event) => { event.preventDefault(); void browse(); });
  $("browse-root").addEventListener("click", () => { $("container-id").value = ""; void browse(); });
  fetch("/api/config").then((response) => { if (!response.ok) throw new Error(); return response.json(); }).then((config) => {
    $("telemetry-mode").textContent = config.demoMode ? "Demo podaci — simulirani trend i alarm" : "Podaci s kontrolera";
    if (config.demoMode) $("history-id").value = "demo-history";
  }).catch(() => status("telemetry-mode", "Provjera izvora nije uspjela. Osvježi stranicu.", true));
})();
