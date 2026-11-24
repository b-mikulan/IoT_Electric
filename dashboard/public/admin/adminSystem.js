(function () {
  "use strict";
  const { request } = globalThis.IoTAdmin;
  const element = id => document.getElementById(id);
  const faults = new Map();
  let sessionRequest = 0;
  function report(area, message) {
    if (message) faults.set(area, message); else faults.delete(area);
    element("admin-system-status").textContent = [...faults.values()].join(" ");
    element("admin-system-status").classList.toggle("is-error", faults.size > 0);
    element("admin-system-retry").hidden = faults.size === 0;
  }
  const settings = globalThis.IoTDashboardSettings.create({
    onPolling(state) {
      element("admin-polling-status").textContent = state.catalogScan ? "Skeniranje zgrade · očitanja i upravljanje su pauzirani" : state.active ? "Osvježavanje u tijeku"
        : state.paused ? "Automatsko osvježavanje je pauzirano" : "Automatsko osvježavanje je uključeno";
      if (!state.active) void loadHealth();
    },
  });
  async function loadHealth() {
    try {
      const data = await request("/health");
      element("admin-source").textContent = ({ demo: "Demo", connected: "Povezano", starting: "Pokretanje" })[data.source] || "Nije povezano";
      element("admin-health-status").textContent = data.source === "demo" ? "Demo podaci · nema veze sa stvarnim uređajima."
        : data.source === "connected" ? "Veza s izvorom podataka je uspostavljena."
          : "Izvor podataka trenutačno nije povezan. Provjeri vezu i postavke servisa.";
      element("admin-health-status").classList.toggle("is-error", !["demo", "connected", "starting"].includes(data.source));
      const date = data.lastSync && new Date(data.lastSync);
      element("admin-last-sync").textContent = date && Number.isFinite(date.getTime()) ? date.toLocaleString("hr-HR") : "Još nema očitanja";
      report("health", null);
    } catch (error) {
      element("admin-source").textContent = "Nedostupno";
      element("admin-health-status").textContent = "Status izvora podataka nije dostupan.";
      element("admin-last-sync").textContent = "Nije dostupno";
      report("health", `Status sustava nije dostupan. ${error.message}`);
    }
  }
  async function loadSessions() {
    const generation = ++sessionRequest;
    try {
      const data = await request("/api/admin/sessions");
      if (generation !== sessionRequest) return;
      element("admin-session-count").textContent = String(data.total);
      element("admin-current-user").textContent = data.currentUsername;
      document.dispatchEvent(new CustomEvent("admin-sessions-updated", { detail: data }));
      report("sessions", null);
    } catch (error) {
      if (generation !== sessionRequest) return;
      element("admin-session-count").textContent = "—";
      document.dispatchEvent(new CustomEvent("admin-sessions-updated", { detail: null }));
      report("sessions", `Aktivne sesije nisu dostupne. ${error.message}`);
    }
  }
  async function loadSettings() {
    try {
      const data = await request("/api/dashboard/settings");
      settings.setSettings(data);
      settings.setPolling(data.polling);
      settings.setCapabilities(data.capabilities);
      element("admin-rooms-link").hidden = data.capabilities.deviceSettingsEnabled !== true;
      element("admin-visibility-link").hidden = data.capabilities.widgetEditingEnabled !== true;
      element("admin-discovery-link").hidden = data.capabilities.discoveryEnabled !== true;
      report("settings", null);
    } catch (error) { report("settings", `Postavke nisu dostupne. ${error.message}`); }
  }
  async function loadTransfer() {
    try {
      const data = await request("/api/dashboard-transfer/status");
      element("admin-transfer-link").hidden = !data.enabled;
      report("transfer", null);
    } catch (error) { report("transfer", `Prijenos postavki nije dostupan. ${error.message}`); }
  }
  const pointText = count => `${count} ${count % 10 === 1 && count % 100 !== 11 ? "točka" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? "točke" : "točaka"}`;
  let demoMode = false;
  async function loadInstallation() {
    try {
      const data = await request("/api/admin/system");
      demoMode = data.demoMode;
      element("install-dashboard-version").textContent = data.dashboardVersion || "Nepoznata (lokalni build)";
      const middleware = data.middleware;
      element("install-middleware").textContent = data.demoMode ? "Demo način · ne koristi se"
        : middleware.reachable ? `Dostupan · verzija ${middleware.version || "nepoznata"}` : middleware.error || "Nije dostupan";
      element("install-middleware").classList.toggle("is-error", !data.demoMode && !middleware.reachable);
      element("install-points").textContent = data.demoMode ? "Demo podaci"
        : data.pointCount ? pointText(data.pointCount) : "Još nema točaka. Dodaj ih kroz Dodavanje mjernih točaka.";
      const warning = element("install-version-warning");
      warning.hidden = !data.versionMismatch;
      warning.textContent = data.versionMismatch ? `Dashboard (${data.dashboardVersion}) i middleware (${middleware.version}) imaju različite verzije. Postavi isti IMAGE_TAG za oba servisa.` : "";
      const hints = element("install-hints");
      hints.replaceChildren(...data.hints.map(text => Object.assign(document.createElement("li"), { textContent: text })));
      hints.hidden = data.hints.length === 0;
      element("install-controller-check").disabled = data.demoMode;
      element("install-backup").hidden = !data.backupAvailable;
      report("installation", null);
    } catch (error) { report("installation", `Stanje instalacije nije dostupno. ${error.message}`); }
  }
  element("install-controller-check").addEventListener("click", async () => {
    const button = element("install-controller-check");
    const status = element("install-controller-status");
    button.disabled = true;
    status.classList.remove("is-error", "is-success");
    status.textContent = "Provjeravam vezu s kontrolerom…";
    try {
      const result = await request("/api/admin/system/controller-check", {});
      status.textContent = result.message;
      status.classList.toggle("is-success", result.state === "connected");
      status.classList.toggle("is-error", !["connected", "demo"].includes(result.state));
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("is-error");
    } finally { button.disabled = demoMode; }
  });
  function loadSystem() { void Promise.all([loadHealth(), loadSessions(), loadSettings(), loadTransfer(), loadInstallation()]); }
  element("admin-system-retry").addEventListener("click", loadSystem);
  document.addEventListener("admin-sessions-refresh", loadSessions);
  const events = new EventSource("/api/dashboard/events");
  events.addEventListener("dashboard-settings", event => settings.setSettings(JSON.parse(event.data)));
  events.addEventListener("polling", event => settings.setPolling(JSON.parse(event.data)));
  events.addEventListener("dashboard-imported", () => window.location.reload());
  events.addEventListener("session-ended", () => { events.close(); window.location.replace("/login"); });
  events.addEventListener("open", () => report("events", null));
  events.addEventListener("error", () => report("events", "Živa veza je prekinuta. Pokušavam se ponovno povezati."));
  const refresh = () => { if (!document.hidden) void Promise.all([loadHealth(), loadSessions()]); };
  const timer = setInterval(refresh, 30_000);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pagehide", () => { clearInterval(timer); events.close(); });
  window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
  loadSystem();
})();
