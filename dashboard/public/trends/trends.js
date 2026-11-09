(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const formatTime = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("hr-HR") : String(value || "—");
  const text = DataTable.render.text();
  const dateColumn = (data) => ({ data, render: (value, type) => type === "display" || type === "filter" ? text.display(formatTime(value)) : Date.parse(value) || 0 });
  const language = { emptyTable: "Nema podataka za prikaz", search: "Pretraži:", searchPlaceholder: "Pretraži zapise", thousands: ".", lengthMenu: "Prikaži _MENU_ redaka", info: "_START_–_END_ od _TOTAL_ redaka", infoEmpty: "0 redaka", infoFiltered: "(od ukupno _MAX_)", zeroRecords: "Nema rezultata pretrage", paginate: { first: "Prva", last: "Zadnja", next: "Sljedeća", previous: "Prethodna" } };
  const tableOptions = { language, pageLength: 10, initComplete() {
    this.api().table().container().querySelectorAll(".dt-length select").forEach(select => select.classList.add("browser-default"));
  } };
  const historyTable = new DataTable("#history-table", { ...tableOptions, order: [[0, "asc"]], columns: [dateColumn("timestamp"), { data: "value", defaultContent: "—", render: text }, { data: "state", defaultContent: "—", render: text }] });
  const alarmsTable = new DataTable("#alarms-table", { ...tableOptions, order: [[0, "desc"]], columns: [dateColumn("timestamp"), dateColumn("occurredAt"), ...["source", "message", "priority", "state", "type", "id", "sourceId"].map((data) => ({ data, defaultContent: "—", render: text }))] });
  const state = {
    history: { rows: [], query: null, cursor: null, seen: new Set(), busy: false, table: historyTable },
    alarms: { rows: [], query: {}, cursor: null, seen: new Set(), busy: false, table: alarmsTable },
  };
  function selectTrend(item) {
    if (state.history.busy) return;
    $("history-id").value = item.id;
    $("history-selected").textContent = `Odabrano: ${item.name}${item.description ? ` · ${item.description}` : ""}`;
    $("history-selected").hidden = false;
    $("trend-catalog").open = false;
    status("history-status", "Odaberi razdoblje i klikni „Dohvati trend”.");
    $("time-from").focus();
  }
  const catalogLanguage = { ...language, search: "Pretraži trendove:", searchPlaceholder: "Naziv, opis ili putanja", emptyTable: "Nema spremljenih trendova", lengthMenu: "Prikaži _MENU_ trendova" };
  const catalogTable = new DataTable("#trend-catalog-table", { ...tableOptions, language: catalogLanguage, deferRender: true, order: [[0, "asc"]], columns: [
    { data: "name", render: (value, type, row) => type === "display" ? `${text.display(value)}${row.unit && row.unit.toLowerCase() !== "none" ? ` <span class="trend-unit">${text.display(row.unit)}</span>` : ""}` : value },
    { data: "description", defaultContent: "—", render: text },
    { data: null, render: (_value, type, row) => {
      const context = [row.device?.label, row.device?.room?.label, row.device?.room?.floorLabel].filter(Boolean);
      const path = row.parentIds?.length ? row.parentIds.join(" · ") : row.id;
      const label = [...context, path.replace(/^(?:00|03)\//, "").replaceAll("/", " › ")].join(" · ");
      return type === "display" ? text.display(label) : `${label} ${row.id} ${row.valueItemId || ""}`;
    }, createdCell: cell => cell.classList.add("trend-location") },
    { data: null, defaultContent: "", orderable: false, searchable: false, createdCell: (cell, _value, row) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "btn-small tonal trend-select-button"; button.textContent = "Odaberi";
      button.setAttribute("aria-label", `Odaberi trend ${row.name}`);
      button.disabled = state.history.busy;
      button.addEventListener("click", () => selectTrend(row));
      cell.replaceChildren(button);
    } },
  ] });

  async function loadCatalog() {
    $("trend-catalog-reload").disabled = true;
    status("trend-catalog-status", "Učitavam spremljeni popis trendova…");
    try {
      const response = await fetch("/api/history/catalog", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error || "Popis trendova nije dostupan.");
      catalogTable.clear(); catalogTable.rows.add(result.items).draw(false);
      $("telemetry-mode").textContent = result.demoMode ? "Demo podaci — simulirani trend i alarm" : "Podaci s kontrolera";
      if (result.demoMode && !$("history-id").value) $("history-id").value = "demo-history";
      const captured = result.capturedAt ? ` · snimka ${formatTime(result.capturedAt)}` : "";
      status("trend-catalog-status", result.available
        ? `${result.total.toLocaleString("hr-HR")} trendova iz spremljenog kataloga${captured}. Za podatke odaberi trend i razdoblje.`
        : "Popis trendova još nije prenesen na ovaj dashboard. Uvezi novu sigurnosnu kopiju s popisom ili koristi pregled mapa ispod.");
    } catch (error) { status("trend-catalog-status", error.message, true); }
    finally { $("trend-catalog-reload").disabled = false; }
  }
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
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    chart = new Chart($("history-chart"), {
      type: "line", data: { datasets: [{ label: unit && unit !== "none" ? `Vrijednost (${unit})` : "Vrijednost", data: points, borderColor: "#00796b", borderWidth: 1.5, pointRadius: points.length > 200 ? 0 : 2, spanGaps: false }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        scales: { x: { type: "linear", grid: { color: "#e7efeb" }, ticks: { color: "#60786e", maxTicksLimit: 6, callback: (value) => formatTime(new Date(value).toISOString()) }, title: { display: true, text: "Vrijeme", color: "#60786e" } }, y: { grid: { color: "#e7efeb" }, ticks: { color: "#60786e" } } },
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
    if (kind === "history") document.querySelectorAll(".trend-select-button").forEach(button => { button.disabled = true; });
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
      if (kind === "history") document.querySelectorAll(".trend-select-button").forEach(button => { button.disabled = false; });
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
        li.className = "collection-item";
        button.type = "button";
        button.className = "btn text browse-item";
        const kind = document.createElement("span"), copy = document.createElement("span"), name = document.createElement("strong"), id = document.createElement("small");
        kind.className = "browse-kind"; kind.textContent = item.kind === "container" ? "Mapa" : "Trend";
        copy.className = "browse-copy"; name.textContent = item.name; id.textContent = item.id;
        copy.append(name, id); button.append(kind, copy);
        button.addEventListener("click", () => {
          if (item.kind === "container") { $("container-id").value = item.id; void browse(); }
          else selectTrend(item);
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
  $("trend-catalog-reload").addEventListener("click", () => void loadCatalog());
  $("history-id").addEventListener("input", () => { $("history-selected").hidden = true; });
  void loadCatalog();
})();
