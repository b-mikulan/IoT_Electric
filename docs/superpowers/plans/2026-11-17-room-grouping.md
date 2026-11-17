# Room Grouping of Device Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always show device cards ordered floor → room → device type, with room (and, across floors, floor) headings in the card grid.

**Architecture:** A pure ordering function in the shared device model (`deviceModel.js`) produces the display order. `deviceCards.js` keeps that order as a list of keys, filters it in `applyFilter`, and places heading elements before the first card of each room and floor in the visible slice. Live value updates never recompute the order. The order is recomputed only on a full `update()` or when a device's label, type or room changes.

**Tech Stack:** Plain browser JS (CommonJS-compatible IIFE modules), CSS, `node --test` with the existing DOM fixture in `dashboard/test/deviceCardsControls.test.js`.

**Spec:** `docs/superpowers/specs/2026-11-17-room-grouping-design.md`

## Global Constraints

- Ordering applies always: all devices, selected floor, selected room, type filter, text search.
- Floor order = order of saved `floors`; floor not in that list / missing → after known floors; devices with no room → last.
- Room order = `label.localeCompare(other, "hr", { numeric: true })`; ties broken by room id so equally named rooms stay separate.
- Type order: `zone`, `lightGroup`, `light`, `blind`, `climate`, `sensor`, `generic`; any other type ranks as `generic`.
- Within one type: label (`hr`, numeric), then `key`.
- Only top-level cards are ordered. Lights inside a group and sensors inside a zone stay nested as today.
- `CARD_BATCH_SIZE` (24) counts cards only, never headings.
- Live value updates (`updateValues` without label/type/room changes) must not move cards.
- No backend, storage or transfer format changes.

## Review Focus

- Pagination boundary inside one room: "Prikaži još uređaja" must continue under the same room with no repeated heading.
- An installation where no device has a room (all "Bez prostorije"): no headings at all, grid identical to today apart from order.
- Two rooms with the same name on the same floor (different ids): each gets its own heading, and their cards do not interleave.
- Selecting a single room, or a floor that has only one room: headings hidden.
- A `updateValues` call that changes a device's room: the card moves and headings are recomputed; a value-only change moves nothing.

---

### Task 1: Display ordering in the device model

**Files:**
- Modify: `dashboard/public/devices/deviceModel.js` (new function near `deviceMembership`, add to `api` at line ~503)
- Test: `dashboard/test/deviceModel.test.js`

**Interfaces:**
- Produces: `sortDevicesForDisplay(devices: Device[], floors: {id, name}[] = []) -> Device[]`, a new array that does not mutate its input. It reads `device.room?.label`, `device.room?.id`, `device.room?.floorId`, `device.type`, `device.label` and `device.key`. Exported on the model `api` (and so on `globalThis.IoTDeviceModel` in the browser).
- Produces: `DEVICE_TYPE_ORDER` constant (array above), not exported.

- [ ] **Step 1: Write the failing tests** in `deviceModel.test.js` (import `sortDevicesForDisplay`):

```js
const d = (key, type, label, room) => ({ key, type, label, room });
const floors = [{ id: "f2", name: "2. kat" }, { id: "f1", name: "1. kat" }];

test("display order is saved floor order, then room name, then device type, then label", () => {
  const input = [
    d("k1", "climate", "Klima", { id: "r10", label: "Ured 10", floorId: "f1" }),
    d("k2", "light", "Svjetlo", { id: "r2", label: "Ured 2", floorId: "f1" }),
    d("k3", "zone", "Zona", { id: "r2", label: "Ured 2", floorId: "f1" }),
    d("k4", "blind", "Roleta B", { id: "r2", label: "Ured 2", floorId: "f1" }),
    d("k5", "blind", "Roleta A", { id: "r2", label: "Ured 2", floorId: "f1" }),
    d("k6", "sensor", "Senzor", { id: "r9", label: "Hodnik", floorId: "f2" }),
    d("k7", "lightGroup", "Grupa", { id: "r2", label: "Ured 2", floorId: "f1" }),
  ];
  const snapshot = input.map((x) => x.key);
  assert.deepEqual(sortDevicesForDisplay(input, floors).map((x) => x.key), ["k6", "k3", "k7", "k2", "k5", "k4", "k1"]);
  assert.deepEqual(input.map((x) => x.key), snapshot, "input is not mutated");
});

test("unknown floors follow known floors, devices without a room come last, unknown types rank as generic", () => {
  const input = [
    d("none", "light", "A", undefined),
    d("unknownFloor", "light", "A", { id: "x", label: "A", floorId: "f9" }),
    d("nullFloor", "light", "A", { id: "y", label: "B", floorId: null }),
    d("known", "light", "A", { id: "z", label: "Z", floorId: "f1" }),
    d("odd", "pump", "A", { id: "z", label: "Z", floorId: "f1" }),
    d("generic", "generic", "B", { id: "z", label: "Z", floorId: "f1" }),
  ];
  assert.deepEqual(sortDevicesForDisplay(input, floors).map((x) => x.key), ["known", "odd", "generic", "unknownFloor", "nullFloor", "none"]);
});

test("equally named rooms on one floor stay separate, ordered by room id", () => {
  const input = [
    d("b1", "light", "1", { id: "kitchen-b", label: "Kuhinja", floorId: "f1" }),
    d("a1", "light", "1", { id: "kitchen-a", label: "Kuhinja", floorId: "f1" }),
    d("b0", "zone", "0", { id: "kitchen-b", label: "Kuhinja", floorId: "f1" }),
  ];
  assert.deepEqual(sortDevicesForDisplay(input, floors).map((x) => x.key), ["a1", "b0", "b1"]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test --prefix dashboard -- --test-name-pattern="display order|unknown floors follow|equally named rooms"`
Expected: FAIL (`sortDevicesForDisplay is not a function`).

- [ ] **Step 3: Implement `sortDevicesForDisplay` in `deviceModel.js` and add it to `api`.**
Compare in this sequence: floor rank (index in `floors`; floor id missing or not listed → `floors.length`; device with no `room?.label` → `floors.length + 1`), then room label (`hr`, numeric), then room id, then type rank, then label (`hr`, numeric), then key. Use a copied array and `Array.prototype.sort` (stable).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test --prefix dashboard -- --test-name-pattern="display order|unknown floors follow|equally named rooms"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/devices/deviceModel.js dashboard/test/deviceModel.test.js
git commit -m "Add floor, room and type display order to the device model"
```

---

### Task 2: Cards follow the display order

**Files:**
- Modify: `dashboard/public/devices/deviceCards.js` (`update()` ~line 1031, `updateValues()` ~line 1085, `applyFilter()` ~line 383, `destroy()` ~line 1096)
- Test: `dashboard/test/deviceCardsControls.test.js`

**Interfaces:**
- Consumes: `globalThis.IoTDeviceModel.sortDevicesForDisplay(devices, floors)` from Task 1.
- Produces: closure state `displayOrder: string[]` (device keys) in `create()`. `applyFilter` builds `filteredDevices` as `displayOrder.map(key => devicesByKey.get(key))` and then applies the existing filter predicate. Task 3 relies on `pageDevices` and `shownDevices` being in this order.

- [ ] **Step 1: Make the test fixture use the real ordering.** In `setup()`, change the default model to `{ buildDevices: () => devices, deviceMembership, sortDevicesForDisplay }` (import it next to `deviceMembership`).

- [ ] **Step 2: Write the failing tests:**

```js
test("cards are ordered by room and type, and a value-only update moves nothing", (t) => {
  const room = (id, label) => ({ id, label, floorId: "f1" });
  const climate = { ...device("climate", {}), key: "ES/C", label: "Klima", room: room("r1", "Ured 1") };
  const zone = { ...device("zone", {}), key: "ES/Z", label: "Zona", room: room("r1", "Ured 1") };
  const other = { ...device("light", {}), key: "ES/L", label: "Svjetlo", room: room("r0", "Arhiva") };
  const { container, update } = setup(t, [climate, zone, other], undefined, false, undefined, { floors: [{ id: "f1", name: "1. kat" }] });
  const cardKeys = () => byClass(container, "dc-grid")[0].children.filter((n) => n.dataset.deviceKey).map((n) => n.dataset.deviceKey);
  assert.deepEqual(cardKeys(), ["ES/L", "ES/Z", "ES/C"]);
  update([{ ...climate, label: "Klima" }, zone, other]);
  assert.deepEqual(cardKeys(), ["ES/L", "ES/Z", "ES/C"]);
});

test("a room change delivered through updateValues moves the card", (t) => {
  // Use a model stub whose createDeviceIndex().updateValues returns `other` with room "Zzz";
  // after view.updateValues({ widgets: [] }) the order becomes ["ES/Z", "ES/C", "ES/L"].
});
```

Write the second test fully with a `options.model` stub that provides `createDeviceIndex` (`getDevices` returns the three devices, `updateValues` returns `[{ ...other, room: { id: "r9", label: "Zzz", floorId: "f1" } }]`), plus `deviceMembership` and `sortDevicesForDisplay`.

- [ ] **Step 3: Run them and confirm they fail**

Run: `npm test --prefix dashboard -- --test-name-pattern="ordered by room and type|room change delivered"`
Expected: FAIL (the cards are in insertion order).

- [ ] **Step 4: Implement.**
- In `update()`, after `devicesByKey` is set, set `displayOrder` from `sortDevicesForDisplay(devices, registeredFloors)`. If the model lacks the function, fall back to `devices` order.
- In `updateValues()`, when `filtersChanged`, recompute `displayOrder` from the current `devices` before `applyFilter()`.
- `applyFilter()` iterates `displayOrder` instead of `devices` to build `filteredDevices`. Member collection (`members` map) keeps iterating `devices`.
- Clear `displayOrder` in `destroy()`.

- [ ] **Step 5: Run the full dashboard suite**

Run: `npm test --prefix dashboard`
Expected: all pass. The existing grid-order tests (light group, zone sensors, floor buttons) already match type/label order. If any other test fails only because it asserted insertion order, fix its expected array to the spec order; do not change the sort.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/devices/deviceCards.js dashboard/test/deviceCardsControls.test.js
git commit -m "Order device cards by floor, room and type"
```

---

### Task 3: Room and floor headings in the grid

**Files:**
- Modify: `dashboard/public/devices/deviceCards.js` (`applyFilter()` placement loop at lines ~421-427)
- Modify: `dashboard/public/devices/deviceCards.css` (near `.dc-grid`, line ~90)
- Modify: `docs/device-cards.md` (section "5. Prostorija"), `dashboard/README.md` (device-card feature list)
- Test: `dashboard/test/deviceCardsControls.test.js`

**Interfaces:**
- Consumes: `displayOrder`, `pageDevices` and `shownDevices` from Task 2. Also uses the existing `roomKey(device)`, `floorLabel(key)` and `availableRooms`.
- Produces: heading elements `h3.dc-grid-heading` with modifier `dc-grid-heading-floor` or `dc-grid-heading-room`. They have no `dataset.deviceKey` and are cached in a `Map` keyed `floor:<floorKey>` / `<roomKey>`.

Rules (builder's calls recorded in the spec spirit):
- Room headings show when `pageDevices` spans more than one `roomKey`. This covers "single room selected" and "no rooms at all".
- Floor headings show when `pageDevices` spans more than one floor key (`device.room?.floorId || "unknown"`; devices with no room have no floor heading).
- A heading is inserted before the first card of its group within `shownDevices`. A group continued after "Prikaži još uređaja" gets no second heading.
- Room heading text: `device.room.label`, or `"Bez prostorije"`. Floor heading text: `floorLabel(floorKey)`.

- [ ] **Step 1: Write the failing tests** (fixture: 3 floors from the existing `floors` option, devices with `room: { id, label, floorId }`):

```js
const headings = (container) => byClass(container, "dc-grid-heading").filter((n) => n.parent).map((n) => `${n.className.includes("floor") ? "F" : "R"}:${n.textContent}`);
```

- `"a floor view heads each room before its cards"`: devices in `Ured 2` (zone, light) and `Ured 10` (climate) on floor f1. After `selectFloor(container, "f1")`: `headings(...)` equals `["R:Ured 2", "R:Ured 10"]`, and the grid children sequence is heading, zone, light, heading, climate.
- `"all floors adds floor headings; one selected room shows none"`: devices on f1 and f2. With no selection the result is `["F:1. kat", "R:…", "F:2. kat", "R:…"]`. After clicking the room filter for one room, `headings(...)` is `[]`.
- `"a room split by load more keeps a single heading"`: 30 lights in one room plus 1 in a second room on the same floor. The first slice has exactly one `R:` heading before 24 cards. After clicking `dc-load-button` ("Prikaži još uređaja"): 2 headings total, 31 cards, and `byClass(container, "dc-card").length` still counts cards only.
- `"devices without rooms produce no headings"`: three devices with no `room`; `headings(...)` is `[]`.
- `"two rooms with the same name get separate headings"`: `Kuhinja` id `a` and `b` on f1 → `["R:Kuhinja", "R:Kuhinja"]`, each followed only by its own cards.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test --prefix dashboard -- --test-name-pattern="heads each room|floor headings|load more keeps|without rooms produce|same name get separate"`
Expected: FAIL (no `dc-grid-heading` elements).

- [ ] **Step 3: Implement.**
In `applyFilter()`, build `nodes` = `shownDevices` interleaved with the needed headings (reuse cached elements, update `textContent` only when changed). Position `nodes` by index in `grid.children` exactly as the current loop positions cards. Remove cached headings not in `nodes` from the DOM. Call `card.setMembers` per card as now. Load-more counts stay based on `shownDevices` and `pageDevices`.
CSS: `.dc-grid-heading { grid-column: 1 / -1; margin: 8px 0 -6px; }`, with the floor variant larger or stronger. Use existing text colour variables from `deviceCards.css`. The first heading in the grid has no top margin.

- [ ] **Step 4: Run the full dashboard suite**

Run: `npm test --prefix dashboard`
Expected: all pass.

- [ ] **Step 5: Document.** In `docs/device-cards.md` §5 and the dashboard README card section, add 2-4 lines on the order (floor → room → type list) and when headings appear.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/devices/deviceCards.js dashboard/public/devices/deviceCards.css dashboard/test/deviceCardsControls.test.js docs/device-cards.md dashboard/README.md
git commit -m "Head each room and floor in the device card grid"
```

---

### Task 4: Verify in the browser (demo mode)

- [ ] **Step 1:** Run `npm test` from the repo root. Expected: all suites pass.
- [ ] **Step 2:** Start the dashboard in demo mode (`DEMO_MODE=true`, see `dashboard/.env.example`) without touching `dashboard/config/` data. Send no real device commands. Open `http://localhost:3001` and the technical page. Check: all-devices view (floor and room headings), one floor, one room (no headings), search, the type filter, "Prikaži još uređaja" in a large room, and a phone-width layout.
- [ ] **Step 3:** If demo data has no rooms or floors, state that in the report rather than editing installation data.
