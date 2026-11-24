// Light, dark or system theme, remembered per browser.
//
// Load this file with a plain <script> in <head>, before the stylesheets. It
// sets data-theme on <html> while the page is still parsing, so a stored dark
// choice never paints a light page first. The colours themselves are the
// tokens in styles.css; this file only picks which set applies.
(function () {
  "use strict";
  const storageKey = "iotElectric.dashboard.theme";
  const choices = ["light", "dark", "system"];
  const labels = { light: "Svijetla tema", dark: "Tamna tema", system: "Tema sustava" };
  const icons = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
    system: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  };
  const root = document.documentElement;
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  // Storage can be missing or throw (private mode, blocked cookies): fall back to the system theme.
  function readChoice() {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return choices.includes(stored) ? stored : "system";
    } catch {
      return "system";
    }
  }

  function writeChoice(choice) {
    try {
      if (choice === "system") window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, choice);
    } catch {
      // The choice still applies to this page; it is just not remembered.
    }
  }

  function resolve(choice) {
    if (choice === "light" || choice === "dark") return choice;
    return media && media.matches ? "dark" : "light";
  }

  let choice = readChoice();
  let theme = "";

  function syncSwitches() {
    for (const button of document.querySelectorAll(".theme-option[data-theme-choice]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
    }
  }

  const reducedMotion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const fadeMs = 220;
  let fadeTimer = 0;

  function apply() {
    const next = resolve(choice);
    const switching = Boolean(theme) && next !== theme;
    // A short, uniform fade between themes; an instant swap for reduced motion.
    // The first paint never animates.
    const instant = switching && reducedMotion?.matches;
    if (instant) root.classList.add("theme-changing");
    if (switching && !instant) {
      clearTimeout(fadeTimer);
      root.classList.add("theme-animating");
      fadeTimer = setTimeout(() => root.classList.remove("theme-animating"), fadeMs + 80);
    }
    root.dataset.theme = next;
    root.dataset.themeChoice = choice;
    syncSwitches();
    if (instant) {
      void document.body?.offsetHeight; // Apply the new colours while transitions are off.
      root.classList.remove("theme-changing");
    }
    if (next === theme) return;
    const previous = theme;
    theme = next;
    if (previous) document.dispatchEvent(new CustomEvent("iot-themechange", { detail: { theme, choice } }));
  }

  function set(next) {
    if (!choices.includes(next)) return;
    choice = next;
    writeChoice(choice);
    apply();
  }

  function createSwitch() {
    const group = document.createElement("div");
    group.className = "theme-switch";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Tema");
    for (const option of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-option";
      button.dataset.themeChoice = option;
      button.title = labels[option];
      button.setAttribute("aria-label", labels[option]);
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[option]}</svg>`;
      button.addEventListener("click", () => set(option));
      group.append(button);
    }
    return group;
  }

  // Every page with the shared header gets the switch at the end of its
  // actions; the sign-in pages get it under the panel.
  function mount() {
    if (document.querySelector(".theme-switch")) return;
    const actions = document.querySelector(".page-header-actions");
    if (actions) actions.append(createSwitch());
    else if (document.querySelector(".dashboard-auth-panel")) document.body.append(createSwitch());
    syncSwitches();
  }

  apply();
  media?.addEventListener?.("change", () => { if (choice === "system") apply(); });
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    choice = readChoice();
    apply();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  window.IoTTheme = Object.freeze({
    get choice() { return choice; },
    get theme() { return theme; },
    set,
  });
})();
