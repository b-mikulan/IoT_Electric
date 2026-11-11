(function () {
  "use strict";
  const markup = `
    <dialog id="general-settings-dialog" class="discovery-dialog general-settings-dialog" aria-labelledby="general-settings-title">
      <div class="general-settings-shell">
        <header class="discovery-header">
          <div><p class="eyebrow">IoT Electric</p><h2 id="general-settings-title">Postavke stranice</h2></div>
          <button type="button" class="dialog-close" data-settings-close aria-label="Zatvori postavke">×</button>
        </header>
        <section class="general-refresh-panel" aria-labelledby="general-refresh-title">
          <div><h3 id="general-refresh-title">Osvježavanje podataka</h3><p data-polling-status role="status">Učitavam stanje…</p></div>
          <div class="general-refresh-actions">
            <button type="button" class="general-button" data-settings-pause>Pauziraj</button>
            <button type="button" class="general-button secondary" data-settings-refresh>Osvježi sve sada</button>
          </div>
          <p class="general-hint">Ove postavke vrijede za sve korisnike dashboarda. Pauza zaustavlja automatske provjere; ručno osvježavanje i provjera nakon naredbe i dalje rade. Nakon restarta servisa osvježavanje se nastavlja.</p>
        </section>
        <form id="general-settings-form">
          <div class="general-settings-fields">
            <label>Interval osvježavanja <span class="general-input-unit"><input name="interval" type="number" min="1" max="86400" step="1" required /><span>sekundi</span></span></label>
            <label>Nakon naredbe osvježi <select name="afterWriteScope" class="browser-default"><option value="room">Prostoriju uređaja</option><option value="device">Samo uređaj</option></select></label>
          </div>
          <p class="general-hint">Ako uređaj nema prostoriju, provjerava se samo taj uređaj. Redovita automatska provjera i dalje obuhvaća cijelu zgradu.</p>
          <details class="general-advanced"><summary>Napredne postavke čitanja</summary>
            <div class="general-settings-fields">
              <label>Pointova u paketu<input name="readBatchSize" type="number" min="1" max="500" step="1" required /></label>
              <label>Razmak između paketa <span class="general-input-unit"><input name="delay" type="number" min="0" max="60" step="0.001" required /><span>sekundi</span></span></label>
              <label>Vrijeme čekanja odgovora <span class="general-input-unit"><input name="timeout" type="number" min="0.1" max="120" step="0.1" required /><span>sekundi</span></span></label>
            </div>
            <p class="general-hint">Manji paketi i veći razmak manje opterećuju server. Paketi se čitaju redom, bez paralelnih zahtjeva za očitanja.</p>
          </details>
          <p data-settings-message class="general-settings-message" role="status" aria-live="polite"></p>
          <div class="general-settings-footer"><span class="general-hint" data-settings-persistence></span><button type="submit" class="general-button" data-settings-save>Spremi postavke</button></div>
        </form>
        <nav class="general-shortcuts" aria-label="Upravljanje dashboardom">
          <h3>Organizacija i prikaz</h3>
          <div>
            <button type="button" data-settings-action="rooms">Prostorije i katovi <span aria-hidden="true">↗</span></button>
            <button type="button" data-settings-action="visibility">Vidljivost pointova <span aria-hidden="true">↗</span></button>
            <button type="button" data-settings-action="discovery">Dodaj pointove <span aria-hidden="true">↗</span></button>
            <a href="/transfer.html">Prijenos postavki <span aria-hidden="true">↗</span></a>
            <a href="/trends.html">Trendovi i alarmi <span aria-hidden="true">↗</span></a>
            <a href="/technical.html">Tehnički prikaz <span aria-hidden="true">↗</span></a>
          </div>
        </nav>
      </div>
    </dialog>`;

  function create({ onAction, onPolling } = {}) {
    document.body.insertAdjacentHTML("beforeend", markup);
    const dialog = document.querySelector("#general-settings-dialog");
    const form = dialog.querySelector("form");
    const open = document.querySelector("#general-settings-open");
    const quickPause = document.querySelector("#refresh-pause");
    const pause = dialog.querySelector("[data-settings-pause]");
    const refresh = dialog.querySelector("[data-settings-refresh]");
    const save = dialog.querySelector("[data-settings-save]");
    const message = dialog.querySelector("[data-settings-message]");
    let settings = null;
    let polling = { paused: false, active: false };
    let busy = false;
    let dirty = false;
    let persisted = false;
    const field = name => form.elements.namedItem(name);
    const notify = (text, error = false) => { message.textContent = text; message.classList.toggle("is-error", error); };

    function setSettings(payload, force = false) {
      if (!payload?.settings) return;
      settings = { ...payload.settings };
      persisted = payload.persisted === true;
      save.disabled = false;
      dialog.querySelector("[data-settings-persistence]").textContent = persisted ? "Sprema se na serveru." : "Vrijedi do restarta servisa.";
      if (force || !dirty) {
        field("interval").value = String(settings.intervalMs / 1000);
        field("afterWriteScope").value = settings.afterWriteScope;
        field("readBatchSize").value = String(settings.readBatchSize);
        field("delay").value = String(settings.readBatchDelayMs / 1000);
        field("timeout").value = String(settings.timeoutMs / 1000);
        dirty = false;
      }
      const interval = document.querySelector("#poll-interval");
      if (interval) interval.textContent = `Interval: ${settings.intervalMs / 1000} s`;
    }

    function setPolling(next) {
      if (!next) return;
      polling = { ...polling, ...next };
      const label = polling.paused ? "Nastavi osvježavanje" : "Pauziraj osvježavanje";
      if (quickPause) {
        quickPause.disabled = busy || !settings;
        quickPause.setAttribute("aria-label", label);
        quickPause.setAttribute("title", label);
        quickPause.setAttribute("aria-pressed", String(polling.paused));
        quickPause.classList.toggle("is-paused", polling.paused);
        quickPause.querySelector("span").textContent = polling.paused ? "Nastavi" : "Pauziraj";
      }
      pause.textContent = polling.paused ? "Nastavi osvježavanje" : "Pauziraj osvježavanje";
      pause.disabled = busy || !settings;
      refresh.disabled = busy || polling.active || !settings;
      refresh.textContent = polling.active ? "Osvježavanje u tijeku…" : "Osvježi sve sada";
      dialog.querySelector(".general-refresh-panel").classList.toggle("is-paused", polling.paused);
      dialog.querySelector("[data-polling-status]").textContent = polling.active
        ? polling.paused && polling.scope === "all" && !polling.manual ? "Zaustavljam nakon trenutačnog zahtjeva…" : polling.scope === "partial" ? "Provjeravam odabrane uređaje…" : "Provjeravam sve pointove…"
        : polling.paused ? "Automatsko osvježavanje je pauzirano." : "Automatsko osvježavanje je uključeno.";
      onPolling?.(polling);
    }

    async function request(url, body) {
      const response = await fetch(url, body === undefined ? { cache: "no-store" } : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Promjena nije uspjela.");
      return payload;
    }

    async function togglePause() {
      if (busy || !settings) return;
      busy = true; setPolling(polling); notify("");
      try { const payload = await request("/api/dashboard/pause", { paused: !polling.paused }); setPolling(payload.polling); }
      catch (error) { notify(error.message, true); if (!dialog.open) dialog.showModal(); }
      finally { busy = false; setPolling(polling); }
    }

    open?.addEventListener("click", async () => {
      dirty = false; notify(""); if (settings) setSettings({ settings, persisted }, true);
      dialog.showModal();
      try { const payload = await request("/api/dashboard/settings"); setSettings(payload); setPolling(payload.polling); if (payload.capabilities) setCapabilities(payload.capabilities); }
      catch (error) { notify(error.message, true); }
    });
    dialog.querySelector("[data-settings-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    form.addEventListener("input", () => { dirty = true; notify(""); });
    form.addEventListener("change", () => { dirty = true; notify(""); });
    quickPause?.addEventListener("click", togglePause);
    pause.addEventListener("click", togglePause);
    refresh.addEventListener("click", async () => {
      if (busy || polling.active) return;
      busy = true; setPolling(polling); notify("");
      try { const payload = await request("/api/dashboard/refresh", {}); setPolling(payload.polling); notify("Pokrenuta je provjera cijele zgrade."); }
      catch (error) { notify(error.message, true); }
      finally { busy = false; setPolling(polling); }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      busy = true; save.disabled = true;
      try {
        const payload = await request("/api/dashboard/settings", {
          intervalMs: Math.round(Number(field("interval").value) * 1000),
          readBatchSize: Number(field("readBatchSize").value),
          readBatchDelayMs: Math.round(Number(field("delay").value) * 1000),
          timeoutMs: Math.round(Number(field("timeout").value) * 1000),
          afterWriteScope: field("afterWriteScope").value,
        });
        setSettings(payload, true); notify(payload.persisted ? "Postavke su spremljene." : "Postavke su primijenjene do restarta servisa.");
      } catch (error) { notify(error.message, true); }
      finally { busy = false; save.disabled = false; setPolling(polling); }
    });
    for (const button of dialog.querySelectorAll("[data-settings-action]")) button.addEventListener("click", () => {
      dialog.close();
      const action = button.dataset.settingsAction;
      if (onAction) onAction(action); else window.location.href = `/#${action}`;
    });
    function setCapabilities(config) {
      dialog.querySelector('[data-settings-action="rooms"]').hidden = config.deviceSettingsEnabled !== true;
      dialog.querySelector('[data-settings-action="visibility"]').hidden = config.widgetEditingEnabled !== true;
      dialog.querySelector('[data-settings-action="discovery"]').hidden = config.discoveryEnabled !== true;
    }
    save.disabled = true;
    return { setSettings, setPolling, setCapabilities, showError(error) { notify(error, true); } };
  }

  globalThis.IoTDashboardSettings = { create };
  if (document.currentScript?.hasAttribute("data-standalone")) {
    fetch("/api/dashboard/settings", { cache: "no-store" }).then(response => {
      if (response.status === 403 || response.status === 401) return null;
      if (!response.ok) throw new Error("Postavke nisu dostupne.");
      return response.json();
    }).then(payload => {
      if (!payload) return;
      const view = create();
      view.setSettings(payload);
      view.setPolling(payload.polling);
      view.setCapabilities(payload.capabilities);
      for (const control of document.querySelectorAll("#general-settings-open, #refresh-pause")) control.hidden = false;
      const events = new EventSource("/api/dashboard/events");
      events.addEventListener("dashboard-settings", event => view.setSettings(JSON.parse(event.data)));
      events.addEventListener("polling", event => view.setPolling(JSON.parse(event.data)));
      events.addEventListener("dashboard-imported", () => window.location.reload());
      events.addEventListener("session-ended", () => { events.close(); window.location.replace("/login"); });
    }).catch(() => { /* Settings controls stay hidden when settings are unavailable. */ });
  }
})();
