const userSelect = document.querySelector("#admin-users");
const form = document.querySelector("#admin-user-form");
const username = document.querySelector("#admin-username");
const password = document.querySelector("#admin-password");
const allRooms = document.querySelector("#admin-all-rooms");
const roomField = document.querySelector("#admin-room-field");
const roomSearch = document.querySelector("#admin-room-search");
const roomsList = document.querySelector("#admin-rooms");
const roomsEmpty = document.querySelector("#admin-rooms-empty");
const deleteButton = document.querySelector("#admin-delete");
const saveButton = form.querySelector('[type="submit"]');
const statusLine = document.querySelector("#admin-status");

let users = [];
let rooms = [];
let busy = false;

function showStatus(message, failed = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("dashboard-auth-error", failed);
}

async function request(url, body) {
  const response = await fetch(url, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {});
  if (response.status === 401) window.location.replace("/login");
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Zahtjev nije uspio.");
  return data;
}

function roomSearchText(value) {
  return value.toLocaleLowerCase("hr").normalize("NFD").replace(/\p{M}/gu, "").replaceAll("đ", "d");
}

function filterRooms() {
  const terms = roomSearchText(roomSearch.value).match(/\S+/g) || [];
  let hasMatches = false;
  for (const option of roomsList.children) {
    const text = roomSearchText(option.textContent);
    option.hidden = !terms.every(term => text.includes(term));
    if (!option.hidden) hasMatches = true;
  }
  roomsList.scrollTop = 0;
  roomsEmpty.hidden = hasMatches;
  roomsEmpty.textContent = rooms.length ? "Nema rezultata pretrage." : "Nema prostorija za dodjelu.";
}

function editSelectedUser() {
  const user = users.find(item => item.username === userSelect.value);
  username.value = user?.username || "";
  password.value = "";
  password.required = !user;
  password.placeholder = user ? "Ostavi prazno za postojeću lozinku" : "Najmanje 8 znakova";
  allRooms.checked = user?.roomIds === null;
  roomField.disabled = allRooms.checked;
  deleteButton.hidden = !user;
  const selected = new Set(user?.roomIds);
  const options = rooms.map(room => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = room.id;
    checkbox.checked = selected.has(room.id);
    label.append(checkbox, room.floor ? ` ${room.name} · ${room.floor}` : ` ${room.name}`);
    return label;
  });
  roomsList.replaceChildren(...options);
  filterRooms();
}

function updateUserList(selected = "") {
  const names = users.map(user => user.username).sort((a, b) => a.localeCompare(b, "hr"));
  userSelect.replaceChildren(new Option("Novi korisnik", ""), ...names.map(name => new Option(name, name)));
  userSelect.value = selected;
  editSelectedUser();
}

async function submit(operation) {
  if (busy) return;
  busy = true;
  userSelect.disabled = saveButton.disabled = deleteButton.disabled = true;
  showStatus("Spremam promjene…");
  try { await operation(); }
  catch (error) { showStatus(error.message, true); }
  finally {
    busy = false;
    userSelect.disabled = saveButton.disabled = deleteButton.disabled = false;
  }
}

userSelect.addEventListener("change", () => {
  showStatus("");
  editSelectedUser();
});
allRooms.addEventListener("change", () => { roomField.disabled = allRooms.checked; });
roomSearch.addEventListener("input", filterRooms);
roomSearch.addEventListener("keydown", event => {
  if (event.key === "Enter") event.preventDefault();
});
form.addEventListener("submit", event => {
  event.preventDefault();
  const previousUsername = userSelect.value || null;
  const roomIds = allRooms.checked ? null : [...roomsList.querySelectorAll("input:checked")].map(input => input.value);
  void submit(async () => {
    const { user } = await request("/api/admin/users", { previousUsername, username: username.value, password: password.value, roomIds });
    users = [...users.filter(item => item.username !== previousUsername), user];
    updateUserList(user.username);
    showStatus("Korisnik je spremljen.");
  });
});
deleteButton.addEventListener("click", () => {
  const name = userSelect.value;
  if (!name || !window.confirm(`Izbrisati korisnika „${name}”?`)) return;
  void submit(async () => {
    await request("/api/admin/users/delete", { username: name });
    users = users.filter(user => user.username !== name);
    updateUserList();
    showStatus("Korisnik je izbrisan.");
  });
});

request("/api/admin/users").then(data => {
  users = data.users;
  rooms = data.rooms.sort((a, b) => (a.floor || "").localeCompare(b.floor || "", "hr") || a.name.localeCompare(b.name, "hr"));
  updateUserList();
  userSelect.disabled = false;
  form.hidden = false;
}).catch(error => showStatus(error.message, true));
