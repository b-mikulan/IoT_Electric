# Interactive user guide

Open `docs/korisnicke-upute-dashboard.html` directly in a browser. Everything is
embedded and works offline; the guide does not load the dashboard app or API client.

Rebuild the embedded demo after editing these sources or the card components:

```sh
node tools/user-guide/buildDemo.cjs
```

The build preserves the surrounding guide, screenshots and existing edits. Marked
blocks make rebuilding idempotent. The original card renderer, device model and
grouping code are embedded unchanged from `dashboard/public/devices/`.

`fixture.json` is a small snapshot of device identifiers, room assignments and
function metadata from the local configuration (L3307, G3308, AC309, B301, S3201,
ACX01). All values and states are synthetic. It contains no login data. Refreshing
the page or resetting the demo discards edits; no configuration files are written.

The renderer always uses `demo: true` with no write callback. Content Security
Policy also blocks all connections, external resources and form submissions.
Simulated control drafts are intentionally distinct from readings, matching the
dashboard's existing simulation behavior. The clock updates only for full refreshes.
