# Known issues left open

Findings from the repository audit of 2026-11-16 that were reviewed and
deliberately not changed. Each entry says what the behaviour is, why it may
matter later, and the smallest fix if the decision changes.

## 1. Trends and alarms are not limited by room

- **Where:** `dashboard/app.js` (`/api/history/catalog`, `/api/history/query`,
  `/api/history/browse`, `/api/alarms/query`) and the `viewerEndpoints` /
  `userPostEndpoints` lists in `dashboard/lib/auth/dashboardAuth.js`.
- **Behaviour:** Live values, device cards, refresh and commands respect a
  regular user's assigned rooms. The four trend and alarm routes do not look at
  rooms, so any logged-in user can list every trend, query any trend by ID,
  browse the controller's container tree and read every alarm.
- **Decision:** Accepted. All dashboard users may see building-wide history and
  alarms; this is read-only data and not treated as a security risk.
- **If this changes:** For role `user`, keep only catalog items whose device is
  in `roomAccess.devices`, accept a `historyItemId` only from that filtered
  list, and remove browse and alarms from `userPostEndpoints` (or filter alarms
  by `sourceId`). Add a test with a one-room user.

## 9. Middleware port is published on the host, and its image runs as root

- **Where:** `docker-compose.yml` and `docker-compose.portainer.yml`
  (`ports` of the `middleware` service), root `Dockerfile`.
- **Behaviour:** Port 3000 is reachable on every host interface over plain
  HTTP. The dashboard does not need this; it reaches the middleware over the
  internal Docker network. `POST /api/values/write` can write any controller
  point (the middleware has no per-point "writable" flag; that check lives in
  the dashboard), protected only by the HTTP Basic password. The middleware
  image has no `USER node` line, unlike the dashboard image.
- **Risk:** Anyone on the network who learns the middleware password, for
  example by observing unencrypted traffic, can write to the building directly
  and bypass dashboard accounts and room permissions.
- **If this changes:** Publish as `127.0.0.1:3000:3000` (or remove the port
  mapping where Swagger access from other machines is not needed) and add
  `USER node` to the root `Dockerfile`.

## 11. Unused code in the middleware

- **Where:** `middleware/ewsClient.js`: `getUpdatedAlarmEvents`,
  `acknowledgeAlarmEvents`, `forceValues`, `unforceValues`, their
  `build...Body` functions and `SOAP_ACTIONS` entries, and
  `formatXmlForDisplay`. `middleware/routes/dataRoutes.js`: `GET
  /api/values/test`, which reads six hard-coded `01/ES/Test4EWS/...` points
  (also listed in `middleware/swaggerDocument.js`).
- **Behaviour:** No route, test or tool calls these functions. They are kept as
  a starting point for future alarm acknowledgement and value forcing.
- **Risk:** About 230 lines that are not covered by tests. Force, unforce and
  acknowledge are write operations; if a route is ever added for them, it needs
  the same validation and tests as `/api/values/write` first.
- **If this changes:** Delete the functions, the test route and its Swagger
  entry.
