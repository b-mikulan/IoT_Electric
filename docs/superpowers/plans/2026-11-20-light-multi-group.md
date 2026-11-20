# Lights in Several Light Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one light be listed in several light groups (`lightMembers`) and show it as a full, controllable row inside every group that lists it.

**Architecture:** The shared model function `deviceMembership` changes from "member → one parent" to "member → ordered list of parents". The store stops rejecting a light that another group already lists. `deviceCards.js` keeps one primary card per device (the node that moves between the main list and its first shown group, as today) and adds a mirror card for each further group placement; all instances of a device share the existing `commands`, `drafts` and `selectedKeys` state, so a command sent from any row shows in every row.

**Tech Stack:** Plain browser JS (CommonJS-compatible IIFE modules in `dashboard/public/devices/`), Express backend (CommonJS), `node --test` with the existing DOM fixtures.

**Spec:** No separate spec file. The decisions, agreed with the user on 2026-11-20, are the Global Constraints below.

## Global Constraints

- Only lights change. A sensor stays in at most one zone; `sensorMembers` keeps returning `409 SENSOR_ALREADY_IN_ZONE` for a second zone, and automatic zone pairing is unchanged.
- A light listed in N shown groups appears as a full row (name, reading, switch, slider, expand chevron) in each of those N groups.
- All rows of one light share command state: a pending/accepted/readback/error status set from one row is visible in every row of that light.
- Membership stays display organization only: no change to DALI groups, EBO bindings, room permissions, command checks or polling.
- Storage format is unchanged: `lightMembers` is still an array of device keys on the group entry. Existing documents, backups and transfers stay valid; no migration.
- Parent order for a light = order of the group entries in the saved `devices` document (first entry listing it first).
- With text search active, lights are listed flat, once, as today.
- When none of a light's groups is in the filtered result, the light shows once on the main list with a note: `U grupi: A` for one group, `U grupama: A, B` for several (labels in parent order).
- The light's own room still decides what a regular user sees; `roomAccess.js` behaviour is unchanged.
- Admin-only editing of `lightMembers` stays as is.

## Review Focus

1. A light in groups A and B, where a room or floor filter leaves only B shown: the light must appear inside B (not on the main list and not twice). Test in Task 3.
2. Removing a light from one of its two groups must remove only that row; the other group keeps its row and the light does not reappear on the main list. Test in Task 3.
3. A light whose second group is absent from the dashboard (deleted points) must still show normally in its first group, and the absent key must not create an empty mirror. Test in Task 1 (`gone` key) and Task 3.
4. Selecting a light via the checkbox in one row must show it as selected in its other rows, and bulk room moves must count it once. Test in Task 3.
5. Opening one row's chevron must not open the light's row in the other group (open state is per row). Test in Task 3.

---

### Task 1: Model returns every parent of a light

**Files:**
- Modify: `dashboard/public/devices/deviceModel.js:461-483` (`deviceMembership`)
- Modify: `dashboard/lib/devices/organizationProposal.js:147-153`
- Modify: `dashboard/public/dashboard/app.js:1970-1972` (`shownMembers`), `:1999`, `:2031`
- Modify: `dashboard/public/devices/deviceCards.js:341-348` (`groupMembership`, temporary adapter)
- Test: `dashboard/test/deviceModel.test.js:544-573`

**Interfaces:**
- Produces: `deviceMembership(devices: Device[], deviceSettings?: object[]) → Map<string, string[]>`, member key → parent keys. Lights may have several parents (saved-settings order, no duplicates); sensors have exactly one. A key appears only when it has at least one parent.

- [ ] **Step 1: Update the model tests to the new shape**

Change the `shownInside` helper's expectations to arrays and extend the first test so `L1` is listed by both groups:

```js
assert.deepEqual(shownInside(devices, [
  { key: "GRP", lightMembers: ["L1", "ES/Other/S1", "gone"] },
  { key: "GRP2", lightMembers: ["L1", "L2"] },
  { key: "ES/Zones/Z1", sensorMembers: ["ES/Other/S1", "L2"] },
  { key: "L2", lightMembers: ["L1"], sensorMembers: ["ES/Other/S1"] },
]), { L1: ["GRP", "GRP2"], L2: ["GRP2"], "ES/Other/S1": ["ES/Zones/Z1"] });
```

Add `test("a sensor listed by two zones stays in the first one only")`: two zones both list `S1` in `sensorMembers` → `{ S1: ["Z1"] }`. Convert the expectations of the two zone tests at `:560-573` to single-element arrays (`{ [first]: ["ES/Zones/Z1"], ... }`).

- [ ] **Step 2: Run to verify failure**

Run: `node --test dashboard/test/deviceModel.test.js`
Expected: FAIL in the membership tests (values are strings, not arrays).

- [ ] **Step 3: Implement the new return shape**

In `deviceMembership`, store `parents.get(member) ?? []`. For `lightMembers`, append the group key when not already present. For `sensorMembers` and automatic pairing, add only when the sensor has no parent yet. Update the comment above the function. Then adapt callers without changing their behaviour:
- `organizationProposal.js:147`: iterate `for (const [member, parents] of ...) for (const parent of parents)`.
- `app.js` `shownMembers`: filter `parents.includes(parentKey)`.
- `app.js:1999/2031` (zones only): read `shown.get(device.key)?.[0]`.
- `deviceCards.js` `groupMembership()`: return `new Map([...membership].map(([key, parents]) => [key, parents[0]]))` for now, and delete the stale "shortcut: a light is shown in its first listed group only" comment lines. Task 3 replaces this adapter.

- [ ] **Step 4: Run dashboard tests**

Run: `npm run test:dashboard`
Expected: PASS (organization proposal, card settings and card tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/devices/deviceModel.js dashboard/lib/devices/organizationProposal.js dashboard/public/dashboard/app.js dashboard/public/devices/deviceCards.js dashboard/test/deviceModel.test.js
git commit -m "Return every parent of a listed light from deviceMembership"
```

### Task 2: Store accepts a light in several groups

**Files:**
- Modify: `dashboard/lib/storage/deviceWidgetStore.js:14-31` (`memberLists`), `:110-124` (`checkMembers`)
- Test: `dashboard/test/deviceWidgetStore.test.js:283-311`, `dashboard/test/deviceWidgetSettingsApi.test.js:141-156`

**Interfaces:**
- Produces: `memberLists.<field>.exclusive: boolean` (`lightMembers: false`, `sensorMembers: true`). `LIGHT_ALREADY_GROUPED` is no longer produced anywhere.

- [ ] **Step 1: Change the store test**

Replace the assertion at `deviceWidgetStore.test.js:296` with:

```js
const second = await store.save(card("ES/Room/GRP2", { lightMembers: ["ES/Room/L1"] }), lights);
assert.deepEqual(second.lightMembers, ["ES/Room/L1"]);
assert.deepEqual(store.devices.find((d) => d.key === "ES/Room/GRP").lightMembers, ["ES/Room/L1"]);
```

Keep the existing `SENSOR_ALREADY_IN_ZONE` assertion at `:329` unchanged. Check the following lines (`:306-311`) still describe valid behaviour now that GRP2 may list L1, and adjust their setup only if they relied on the rejection. In `deviceWidgetSettingsApi.test.js`, add one request saving a second group with `"ES/Hall/L1"` and assert status 200.

- [ ] **Step 2: Run to verify failure**

Run: `node --test dashboard/test/deviceWidgetStore.test.js dashboard/test/deviceWidgetSettingsApi.test.js`
Expected: FAIL with `LIGHT_ALREADY_GROUPED`.

- [ ] **Step 3: Implement**

Add `exclusive` to both entries of `memberLists`; drop `taken`/`takenCode` from `lightMembers`. In `checkMembers`, run the "already listed by another present device" lookup only when `list.exclusive`. Update the comment above `memberLists`.

- [ ] **Step 4: Run dashboard tests**

Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/storage/deviceWidgetStore.js dashboard/test/deviceWidgetStore.test.js dashboard/test/deviceWidgetSettingsApi.test.js
git commit -m "Allow a light to be listed by several light groups"
```

### Task 3: Cards render a light in every group that lists it

**Files:**
- Modify: `dashboard/public/devices/deviceCards.js` (state at `:126-160`, `groupMembership` `:341-348`, `updateCard` `:365-378`, `applyFilter` `:426-473`, `makeCard` `setGroupNote` `:607-611`, `commit` `:720`, `update` `:1085-1094`, `updateValues` `:1126-1132`, `destroy` `:1143`)
- Test: `dashboard/test/deviceCardsControls.test.js` (next to the tests at `:868-950`)

**Interfaces:**
- Consumes: `deviceMembership → Map<string, string[]>` (Task 1).
- Produces (module-internal): `memberParents: Map<string, string[]>`; `mirrors: Map<string, Map<string, Card>>` (device key → parent key → mirror card); `instancesOf(deviceKey: string) → Card[]` (primary first, then mirrors); `card.setGroupNote(parents: Device[])` (empty array hides the note).

- [ ] **Step 1: Write the failing tests**

Add `test("a light listed by two groups shows a full row in each and shares its command state")`, using the fixture style of `:868`: groups `ES/GA` "Grupa A" and `ES/GB` "Grupa B", light `ES/L1` "Svjetlo 1", settings `[{ key: "ES/GA", lightMembers: ["ES/L1"] }, { key: "ES/GB", lightMembers: ["ES/L1", "ES/absent"] }]`. Assert:
- grid keys `["ES/GA", "ES/GB"]`; each group's `dc-group-member-list` has one child with `dataset.deviceKey === "ES/L1"`, and the two nodes are different objects; both summaries read `Svjetla u grupi (1)`.
- changing the slider in Grupa B's row sends `[{ widgetId: <L1 LtPct id>, value: 70 }]` and, before the write resolves, both rows' `dc-command-status` are not hidden.
- clicking `dc-member-expand` in Grupa A's row adds `dc-member-open` to that row only.
- in selection mode, ticking the checkbox in Grupa A's row leaves the checkbox in Grupa B's row checked after the next `applyFilter` (trigger through any filter change), and `Odaberi sve rezultate` counts L1 once.
- type filter `light`: grid keys `["ES/L1"]` and its note reads `U grupama: Grupa A, Grupa B`.
- a filter that leaves only Grupa B shown (give the groups different rooms and select Grupa B's room; L1 is in Grupa B's room): L1 appears inside Grupa B only and not on the main list.
- `update` with Grupa B's list emptied: Grupa B's panel is hidden, the Grupa A row is the same node as before, and L1 is not on the main list.

Keep the existing single-group test unchanged; its `U grupi: Grupa hodnik` assertion must still pass.

- [ ] **Step 2: Run to verify failure**

Run: `node --test dashboard/test/deviceCardsControls.test.js`
Expected: the new test FAILS (L1 appears only in Grupa A); existing tests PASS.

- [ ] **Step 3: Implement placements**

- `groupMembership()` returns the Task 1 map unchanged (remove the adapter).
- In `applyFilter` (nested mode): a light leaves the main list when any of its parents is in `filteredKeys`. Build `members: Map<parentKey, Device[]>` from all parents. The primary card goes to the first of the light's parents in `displayOrder` that is in `filteredKeys`; every other filtered parent gets the mirror from `mirrors.get(key).get(parent)`, created with `makeCard(device)` on first use. `setMembers` receives, per group, the primary node or the mirror node as above. Mirrors whose placement is not used in this pass are detached (`node.remove()`, `hidden = true`) but kept.
- Apply the existing per-card loop (hidden flag, selection checkbox, `dc-card-selected`, group note) to mirrors as well. The note: primary card shown at top level gets the parents not in `filteredKeys` (all parents in search mode); nested rows and mirrors get `[]`.
- `setGroupNote(parents)`: hidden when empty; otherwise `U grupi: <label>` for a light group or `U zoni: <label>` for a zone when there is one parent, `U grupama: <labels joined by ", ">` when several.
- Replace single-card updates with `instancesOf(key)`: `updateCard` updates or marks `needsRefresh` on every instance; `commit`'s final refresh updates every instance of `card.device.key` that is still registered; the re-render loop at `:157` and the connection loop in `updateValues` include mirrors.
- `update()`: drop mirrors of absent devices and mirrors whose parent no longer lists the device; `destroy()` clears `mirrors`.

- [ ] **Step 4: Run dashboard tests**

Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/devices/deviceCards.js dashboard/test/deviceCardsControls.test.js
git commit -m "Show a light in every light group that lists it"
```

### Task 4: Card settings let an admin add a light that is already in another group

**Files:**
- Modify: `dashboard/public/dashboard/app.js:1953-1966` (`memberKinds`), `:1985-2037` (`renderCardMemberChoices`)
- Test: `dashboard/test/deviceCardSettings.test.js` (next to the test at `:983`)

**Interfaces:**
- Consumes: `deviceMembership` (Task 1), store behaviour (Task 2).
- Produces: `memberKinds.<type>.exclusive: boolean` (`lightGroup: false`, `zone: true`).

- [ ] **Step 1: Write the failing test**

Add `test("a light already in another group can be added to this group too")`, built like the test at `:983` with a second group `ES/Application/Items/GRP2` whose saved settings list `L1`. Open GRP's settings and assert: the L1 checkbox is not disabled; its `small` text contains `također u grupi ` followed by GRP2's card label (read it from `cardSettingsDevices()`); ticking it and submitting posts `lightMembers: [lightKey]`. Add one assertion to the existing zone test that a sensor already listed in another zone is still disabled.

- [ ] **Step 2: Run to verify failure**

Run: `node --test dashboard/test/deviceCardSettings.test.js`
Expected: FAIL (checkbox disabled).

- [ ] **Step 3: Implement**

`otherGroup` collects all other listing parents' labels per member (`Map<string, string[]>`). Disable a checkbox for a member listed elsewhere only when `kind.exclusive`. For lights, show `također u grupi <labels joined by ", ">` whether or not the box is checked; zones keep `već u zoni <label>` when unchecked. Set `lightGroup.elsewhere` to `"također u grupi"` and append to its `help`: `Svjetlo može biti u više grupa; prikazuje se u svakoj.` Update the comment "The store allows a member in one saved list only".

- [ ] **Step 4: Run dashboard tests**

Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/dashboard/app.js dashboard/test/deviceCardSettings.test.js
git commit -m "Let card settings add a light to several groups"
```

### Task 5: Documentation, user guide and UI check

**Files:**
- Modify: `docs/device-cards.md` (section "Svjetla u grupi rasvjete", sentence "Svjetlo može biti u najviše jednoj grupi")
- Modify: `dashboard/README.md` (light-group paragraph, "A light can belong to one group")
- Regenerate: `docs/korisnicke-upute-dashboard.html` via `node tools/user-guide/buildDemo.cjs`

- [ ] **Step 1: Update both docs**

State: a light can be listed by several groups and appears as a full row in each; rows share command status; open state is per row; when no group is shown, the light is shown once with `U grupama: …`; sensors stay in one zone (`SENSOR_ALREADY_IN_ZONE`). Remove any mention of `LIGHT_ALREADY_GROUPED`.

- [ ] **Step 2: Rebuild the embedded guide demo**

Run: `node tools/user-guide/buildDemo.cjs`
Expected: exits 0; `git diff --stat docs/korisnicke-upute-dashboard.html` shows only the embedded card/model code changed.

- [ ] **Step 3: Full test run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Check the UI against a scratch database**

Demo mode cannot save card settings, so run real mode without a controller: copy `dashboard/config/widgets.json` to a temp folder, then start `npm start --prefix dashboard` with `DEMO_MODE=false`, `WIDGETS_FILE=<temp copy>`, `DASHBOARD_DB_FILE=<temp folder>/dashboard.sqlite` `MIDDLEWARE_URL=http://127.0.0.1:9` (nothing listens there, so no command can reach equipment) and `PORT=3101` so a running dashboard on 3001 is untouched. Admin and middleware credentials come from the existing `dashboard/.env`. Never point `DASHBOARD_DB_FILE` at `dashboard/config/dashboard.sqlite`. Sign in as admin, put one light in two groups through card settings, and confirm on the page: rows in both groups; after moving a slider, both rows show the same command status (pending, then an error because there is no middleware); with the type filter on `Svjetlo`, one row with `U grupama: …`.

- [ ] **Step 5: Commit**

```bash
git add docs/device-cards.md dashboard/README.md docs/korisnicke-upute-dashboard.html
git commit -m "Document lights in several light groups"
```
