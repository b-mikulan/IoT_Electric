(function () {
  "use strict";
  const { request, matches } = globalThis.IoTAdmin;
  const element = id => document.getElementById(id);
  const userList = element("admin-users");
  const userSearch = element("admin-user-search");
  const newButton = element("admin-new");
  const form = element("admin-user-form");
  const username = element("admin-username");
  const password = element("admin-password");
  const allRooms = element("admin-all-rooms");
  const editDeviceSettings = element("admin-edit-device-settings");
  const roomField = element("admin-room-field");
  const roomSearch = element("admin-room-search");
  const roomFloor = element("admin-room-floor");
  const selectedOnly = element("admin-selected-only");
  const roomsList = element("admin-rooms");
  const statusLine = element("admin-status");
  let users = [];
  let rooms = [];
  let selectedUsername = null;
  let busy = false;
  let loaded = false;
  let baseline = "";
  let sessions = null;
  const selectedRooms = new Set();
  const writeRooms = new Set();

  function showStatus(message, failed = false) {
    statusLine.textContent = message;
    statusLine.classList.toggle("is-error", failed);
    statusLine.classList.toggle("is-success", Boolean(message) && !failed);
  }
  function draft() {
    return {
      username: username.value, password: password.value,
      roomIds: allRooms.checked ? null : [...selectedRooms].sort(),
      writeRoomIds: [...writeRooms].sort(),
      canEditDeviceSettings: editDeviceSettings.checked,
    };
  }
  function dirty() { return loaded && JSON.stringify(draft()) !== baseline; }
  function canLeave() {
    return !busy && (!dirty() || window.confirm("Odbaciti nespremljene izmjene korisnika?"));
  }
  function sessionCount(name) { return sessions?.find(item => item.username === name)?.count || 0; }
  function accessLabel(user) {
    const writeCount = rooms.filter(room => user.writeRoomIds?.includes(room.id)).length;
    const control = writeCount ? ` · Upravljanje: ${writeCount}` : "";
    if (user.roomIds === null) return `Sve prostorije${control}`;
    const count = rooms.filter(room => user.roomIds.includes(room.id)).length;
    return count ? `Dozvoljene prostorije: ${count}${control}` : "Bez pristupa prostorijama";
  }
  function renderUsers() {
    const focusedUsername = userList.contains(document.activeElement) ? document.activeElement.dataset.username : null;
    const visible = users.filter(user => matches(user.username, userSearch.value));
    userList.replaceChildren(...visible.map(user => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "admin-user-option";
      button.dataset.username = user.username;
      button.classList.toggle("is-selected", user.username === selectedUsername);
      button.setAttribute("aria-pressed", String(user.username === selectedUsername));
      button.disabled = busy;
      const name = document.createElement("span");
      name.className = "admin-user-name";
      name.textContent = user.username;
      const access = document.createElement("span");
      access.className = "admin-user-access";
      access.textContent = accessLabel(user);
      const count = document.createElement("span");
      count.className = "admin-user-sessions";
      count.textContent = sessions === null ? "Sesije: —" : `Aktivne sesije: ${sessionCount(user.username)}`;
      button.append(name, access, count);
      if (user.mustChangePassword) {
        const setup = document.createElement("span");
        setup.className = "admin-user-access";
        setup.textContent = "Čeka postavljanje lozinke";
        button.append(setup);
      }
      button.addEventListener("click", () => {
        if (user.username === selectedUsername || !canLeave()) return;
        editUser(user.username);
        username.focus();
      });
      return button;
    }));
    if (focusedUsername && !busy) {
      [...userList.children].find(button => button.dataset.username === focusedUsername)?.focus();
    }
    const empty = element("admin-users-empty");
    empty.hidden = !loaded || Boolean(visible.length);
    empty.textContent = users.length ? "Nema korisnika koji odgovaraju pretrazi." : "Još nema korisnika. Dodaj prvi račun.";
    element("admin-user-count").textContent = String(users.length);
    element("admin-room-count").textContent = String(rooms.length);
  }
  function visibleRooms() {
    return rooms.filter(room => (!roomFloor.value || JSON.stringify(room.floor || null) === roomFloor.value)
      && (!selectedOnly.checked || allRooms.checked || selectedRooms.has(room.id))
      && matches(`${room.name} ${room.floor || "Bez kata"}`, roomSearch.value));
  }
  function updateControls() {
    newButton.disabled = busy || !loaded;
    form.setAttribute("aria-busy", String(busy));
    for (const control of form.querySelectorAll("input, select, button")) control.disabled = busy;
    roomField.disabled = busy;
    for (const row of roomsList.children) {
      const [read, , permission] = row.children;
      read.disabled = busy || allRooms.checked;
      permission.hidden = !read.checked;
      permission.disabled = busy || !read.checked;
    }
    element("admin-revoke").disabled = busy || sessions === null || !sessionCount(selectedUsername);
    element("admin-save").textContent = busy ? "Pričekaj…" : selectedUsername === null ? "Dodaj korisnika" : "Spremi izmjene";
    const visible = visibleRooms();
    element("admin-select-visible").disabled = busy || allRooms.checked || !visible.some(room => !selectedRooms.has(room.id));
    element("admin-clear-visible").disabled = busy || allRooms.checked || !visible.some(room => selectedRooms.has(room.id));
  }
  function renderSessions() {
    element("admin-user-session").hidden = selectedUsername === null;
    element("admin-user-session-count").textContent = sessions === null
      ? "Broj aktivnih sesija nije dostupan." : `Aktivne sesije: ${sessionCount(selectedUsername)}`;
    updateControls();
  }
  function renderRooms() {
    const visible = visibleRooms();
    roomsList.replaceChildren(...visible.map((room, index) => {
      const row = document.createElement("div");
      row.className = "admin-room-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = room.id;
      checkbox.id = `admin-room-choice-${index}`;
      checkbox.checked = allRooms.checked || selectedRooms.has(room.id);
      const text = document.createElement("label");
      text.htmlFor = checkbox.id;
      text.textContent = room.name;
      const floor = document.createElement("small");
      floor.textContent = room.floor || "Bez kata";
      text.append(floor);
      const permission = document.createElement("select");
      permission.setAttribute("aria-label", `Pravo za ${room.name}, ${room.floor || "bez kata"}`);
      permission.append(new Option("Samo čitanje", "read"), new Option("Čitanje i upravljanje", "write"));
      permission.value = writeRooms.has(room.id) ? "write" : "read";
      row.append(checkbox, text, permission);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedRooms.add(room.id);
        else {
          selectedRooms.delete(room.id);
          writeRooms.delete(room.id);
          permission.value = "read";
        }
        if (selectedOnly.checked) renderRooms(); else updateRoomSummary();
      });
      permission.addEventListener("change", () => {
        if (permission.value === "write") {
          selectedRooms.add(room.id);
          writeRooms.add(room.id);
        } else writeRooms.delete(room.id);
        updateRoomSummary();
      });
      return row;
    }));
    const empty = element("admin-rooms-empty");
    empty.hidden = visible.length > 0;
    empty.textContent = rooms.length ? "Nema prostorija za odabrane filtre." : "Još nema prostorija. Dodaj ih u organizaciji prostorija i katova.";
    updateRoomSummary();
  }
  function updateRoomSummary() {
    const readSummary = allRooms.checked ? "Pregled svih prostorija i uređaja bez prostorije"
      : `Odabrano ${selectedRooms.size} od ${rooms.length} prostorija`;
    element("admin-room-summary").textContent = `${readSummary} · Upravljanje: ${writeRooms.size} · Prikazano ${visibleRooms().length}`;
    element("admin-no-access").hidden = allRooms.checked || selectedRooms.size > 0;
    updateControls();
  }
  function editUser(name = null, clearStatus = true) {
    selectedUsername = name;
    const user = users.find(item => item.username === name);
    username.value = user?.username || "";
    password.value = "";
    password.required = !user;
    element("admin-editor-title").textContent = user ? "Uredi korisnika" : "Novi korisnik";
    element("admin-password-hint").textContent = user
      ? "Ostavi prazno za postojeću lozinku. Ako upišeš privremenu lozinku, korisnik će pri idućoj prijavi postaviti svoju."
      : "Najmanje 8 znakova. Korisnik će pri prvoj prijavi postaviti svoju lozinku.";
    allRooms.checked = user?.roomIds === null;
    editDeviceSettings.checked = user?.canEditDeviceSettings === true;
    selectedRooms.clear();
    writeRooms.clear();
    for (const room of rooms) if (user?.roomIds?.includes(room.id)) selectedRooms.add(room.id);
    for (const room of rooms) {
      if (!user?.writeRoomIds?.includes(room.id)) continue;
      writeRooms.add(room.id);
      selectedRooms.add(room.id);
    }
    roomSearch.value = "";
    roomFloor.value = "";
    selectedOnly.checked = false;
    element("admin-delete").hidden = !user;
    renderUsers();
    renderRooms();
    renderSessions();
    baseline = JSON.stringify(draft());
    if (clearStatus) showStatus("");
  }
  async function submit(operation) {
    if (busy) return;
    busy = true;
    renderUsers();
    updateControls();
    showStatus("Spremam promjene…");
    try { await operation(); }
    catch (error) { showStatus(error.message, true); }
    finally { busy = false; renderUsers(); updateControls(); }
  }
  function invalidateSessions(name) {
    if (sessions) sessions = sessions.filter(item => item.username !== name);
    renderSessions();
    document.dispatchEvent(new CustomEvent("admin-sessions-refresh"));
  }
  newButton.addEventListener("click", () => { if (canLeave()) { editUser(); username.focus(); } });
  userSearch.addEventListener("input", renderUsers);
  allRooms.addEventListener("change", renderRooms);
  roomSearch.addEventListener("input", renderRooms);
  roomFloor.addEventListener("change", renderRooms);
  selectedOnly.addEventListener("change", renderRooms);
  roomSearch.addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); });
  element("admin-select-visible").addEventListener("click", () => {
    for (const room of visibleRooms()) selectedRooms.add(room.id);
    renderRooms();
  });
  element("admin-clear-visible").addEventListener("click", () => {
    for (const room of visibleRooms()) {
      selectedRooms.delete(room.id);
      writeRooms.delete(room.id);
    }
    renderRooms();
  });
  element("admin-reset").addEventListener("click", () => { if (canLeave()) editUser(selectedUsername); });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const previousUsername = selectedUsername;
    const body = { previousUsername, ...draft() };
    void submit(async () => {
      const { user } = await request("/api/admin/users", body);
      users = [...users.filter(item => item.username !== previousUsername), user].sort((a, b) => a.username.localeCompare(b.username, "hr"));
      userSearch.value = "";
      invalidateSessions(previousUsername);
      editUser(user.username, false);
      showStatus(previousUsername === null ? "Korisnik je dodan." : "Izmjene su spremljene. Korisnik se treba ponovno prijaviti.");
    });
  });
  element("admin-delete").addEventListener("click", () => {
    const name = selectedUsername;
    if (busy || name === null || !window.confirm(`Izbrisati korisnika „${name}”? Njegove aktivne sesije bit će odjavljene.`)) return;
    void submit(async () => {
      await request("/api/admin/users/delete", { username: name });
      users = users.filter(user => user.username !== name);
      invalidateSessions(name);
      editUser(null, false);
      showStatus("Korisnik je izbrisan.");
    });
  });
  element("admin-revoke").addEventListener("click", () => {
    const name = selectedUsername;
    if (busy || name === null || !window.confirm(`Odjaviti sve sesije korisnika „${name}”? Korisnik se može ponovno prijaviti postojećom lozinkom.`)) return;
    void submit(async () => {
      await request("/api/admin/users/revoke", { username: name });
      invalidateSessions(name);
      showStatus("Sve sesije korisnika su odjavljene. Podaci računa nisu promijenjeni.");
    });
  });
  document.addEventListener("admin-sessions-updated", event => {
    sessions = event.detail?.sessions || null;
    if (loaded) { renderUsers(); renderSessions(); }
  });
  window.addEventListener("beforeunload", event => {
    if (busy || dirty()) { event.preventDefault(); event.returnValue = ""; }
  });
  async function load() {
    element("admin-users-retry").hidden = true;
    element("admin-users-loading").hidden = false;
    showStatus("");
    try {
      const data = await request("/api/admin/users");
      users = data.users.sort((a, b) => a.username.localeCompare(b.username, "hr"));
      rooms = data.rooms.sort((a, b) => (a.floor || "").localeCompare(b.floor || "", "hr") || a.name.localeCompare(b.name, "hr"));
      const floors = [...new Set(rooms.map(room => room.floor || null))];
      roomFloor.replaceChildren(new Option("Svi katovi", ""), ...floors.map(floor => new Option(floor || "Bez kata", JSON.stringify(floor))));
      loaded = true;
      form.hidden = false;
      editUser(users[0]?.username || null);
    } catch (error) { showStatus(error.message, true); element("admin-users-retry").hidden = false; }
    finally { element("admin-users-loading").hidden = true; }
  }
  element("admin-users-retry").addEventListener("click", load);
  void load();
})();
