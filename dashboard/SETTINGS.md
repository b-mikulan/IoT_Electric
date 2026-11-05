# Page settings and targeted command refresh

**Postavke** opens the shared dashboard settings on the main dashboard, technical
view, transfer page and trends page. It contains the refresh interval, the scope
of the read after a command, manual refresh, and advanced read batch size, batch
delay and response timeout. It also links to rooms/floors, point visibility,
discovery, transfer, trends and the technical view.

Settings are saved atomically in `dashboard-settings.json` alongside
`widgets.json`, in the existing persistent configuration volume. Saved settings
take precedence over their environment defaults on subsequent starts. With no
persistent `WIDGETS_FILE`, settings apply in memory until restart. The file never
contains credentials. Portable version-2 backups include these settings; older
backups and plain `widgets.json` retain the destination's general settings.
Import recovery supports both previous three-file and new four-file journals.

## Pausing

The **Pauziraj** button pauses the server's automatic value reads for every
dashboard client, rather than merely freezing one browser's view. It keeps the
last readings visible and labels the connection as paused. A running read is
allowed to finish its current request; subsequent batches are skipped and the
incomplete full read is discarded. Manual full refresh and readback after an
explicit command remain available. **Nastavi** starts a new full read. Pause is
temporary and is cleared on service restart; it is not exported in a backup.

## What happens after a device command

1. Existing permission, native-point, state and range checks run against a fresh
   controller response. Forced or otherwise unavailable commands remain blocked.
2. The dashboard submits the command and validates the controller acknowledgement.
   The card distinguishes acknowledgement from confirmed readback.
3. Successful commands within two seconds are coalesced. Two seconds after the
   last acknowledgement, the backend resolves the current room using saved IDs,
   automatic metadata, room rules and manual room assignments. No topology crawl
   or additional metadata lookup is needed for this resolution.
4. By default it selects the configured points of devices in that same room.
   Rooms with the same display name on different floors remain separate. If the
   device has no room, only that device is selected. **Samo uređaj** can restrict
   all command readbacks to the originating device.
5. If an ordinary full read is in progress, it completes its current request and
   yields to the targeted read before sending another batch. Value read requests
   stay sequential and keep the configured batch size and inter-batch gap.
6. The partial read updates only those points and their device cards. It records
   each point's read time even when the value did not change. It preserves other
   rooms' values and the last successful *full-building* sync time.
7. A card confirms its command only after its own fresh point was read and its
   value matches the command. Reading an unrelated room cannot confirm it.
8. Scheduled full reads continue at the configured interval when not paused.
   An interrupted automatic full read resumes as a new read on a later interval;
   a command does not schedule an additional full-building read.

## API

- `GET /api/dashboard/settings`: public settings, persistence availability and
  current polling state; no credentials.
- `POST /api/dashboard/settings`: a complete or partial object containing
  `intervalMs` (1,000–86,400,000), `readBatchSize` (1–500), `readBatchDelayMs`
  (0–60,000), `timeoutMs` (100–120,000), and/or `afterWriteScope` (`room`/`device`).
  Unknown fields and out-of-range values are rejected before persistence.
- `POST /api/dashboard/pause`: `{ "paused": true }` or `{ "paused": false }`.
- `POST /api/dashboard/refresh`: starts a manual full read; returns 202 or 409
  when a read is already active. It does not clear pause.
- Existing SSE streams include `dashboard-settings`, `polling` and scoped
  `refresh-error` events. Partial `update`/`sync` events carry `scope: "partial"`,
  `readAt` and the selected `pointIds`. A partial update does not advance the
  full-building `syncedAt` clock.
- `GET /api/dashboard/events` provides only settings/polling events to the trends
  and transfer pages, without sending the building's point snapshot.
