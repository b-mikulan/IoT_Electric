# IoT Electric PLC dashboard

This is the second, independent Node.js service. It polls the protected DDC middleware, detects changed values with `EventEmitter`, and pushes only those changes to open browsers over Server-Sent Events. The browser never receives the middleware username or password.

## Quick preview

```sh
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3001`. Demo mode is enabled by default and is visibly marked in the interface.

## Trends and alarms

Open **Trendovi i alarmi** on the dashboard (or `/trends.html`). The page uses locally served [DataTables](https://datatables.net/) for searchable, sortable, paginated tables and [Chart.js](https://www.chartjs.org/) for a history line chart. No CDN access is required in the browser.

Use **Pronađi trend kroz mape kontrolera** to browse from the root or paste a known container ID. Select a history item, choose **Od** and **Do**, then click **Dohvati trend**. A trend has its own EWS history ID; the live value/widget ID is not interchangeable with it. Dates use the browser's local time zone and are sent to EWS in UTC. The graph uses elapsed time on its horizontal axis and displays numeric values; the table retains all records and EWS state codes.

Click **Dohvati alarme** to retrieve the controller's alarm event list. The table includes transition/occurrence timestamps, source, message, priority, raw EWS state, type and identifiers. This view reads alarms only; it does not acknowledge them.

Both views expose **Učitaj još** when EWS returns `MoreDataAvailable`. Each click fetches one additional controller page with `MoreDataRef` and the original query. DataTables pagination/search/sort operate on the rows already fetched. The status explicitly distinguishes partial data from a completed query. A new query clears the previous result; a failed continuation retains the successfully fetched rows and allows retrying. A repeated continuation token stops loading and asks for a new query. History and alarm queries run on demand, independently of live widget polling.

The backend calls the existing middleware `/api/history/query`, `/api/alarms/query`, and `/api/containers` endpoints with the configured middleware credentials; credentials remain on the server. Demo mode supplies clearly labelled synthetic history and one demo alarm without contacting EWS.

### Live verification, 22 September 2026

Read-only checks against the configured EWS controller succeeded through the dashboard and authenticated middleware:

- Container `00/ES/Test4EWS/Trend Logs` exposed two history items: **Multistate Value Interval Trend Log** and **Multistate Value Change of Value Trend Log** (IDs start with `03/ES/Test4EWS/Trend Logs/`).
- Each trend returned **1,441 records over two controller pages** for `2026-09-21T00:00:00Z` through `2026-09-22T00:00:00Z`, with a completed continuation sequence.
- The alarm event query returned **4 alarms**, with no further page.
- Browser verification confirmed history discovery, the real history chart/table, **Učitaj još**, and the real alarm table. These counts describe that check; they are not fixed expected production values.

When running the middleware directly on Windows, use the project CA just as the Docker image does: set `NODE_EXTRA_CA_CERTS` to the absolute path of `middleware/root_certificate_iotelectric.crt` before starting Node. TLS verification remains enabled.

## Connect real PLC points with Docker Compose

Widget definitions live in `dashboard/config/widgets.json`, not in the root `.env`. Create the local file once:

```powershell
Copy-Item dashboard/config/widgets.example.json dashboard/config/widgets.json
```

Edit it as normal formatted JSON. Each `id` must match a DDC value identifier accepted by `POST /api/values/read`:

```json
[
  {
    "id": "01/ES/Building/Temperature",
    "label": "Temperatura ureda",
    "description": "Ured · prizemlje",
    "unit": "°C",
    "precision": 1,
    "writable": true
  }
]
```

Then keep only the connection settings in the repository-root `.env`:

```env
DASHBOARD_DEMO_MODE=false
DASHBOARD_MIDDLEWARE_PASSWORD=the_plaintext_middleware_password
DASHBOARD_WIDGETS_FILE=/app/config/widgets.json
```

Local Compose supplies `http://middleware:3000`, the shared `MIDDLEWARE_USER`, and mounts `dashboard/config/` read-write so the discovery dialog can append selected values to `widgets.json`. The dashboard needs the plaintext password because it is an API client; this is the same password entered through Swagger's **Authorize** button. Keep it in the ignored root `.env`, never in the JSON file or Git.

Widgets are read-only by default. A widget appears in the **Postavi vrijednost** dropdown only when it explicitly contains `"writable": true`. The first version accepts finite numeric values and sends them from the dashboard backend to the existing middleware `POST /api/values/write` endpoint, so middleware credentials are never exposed to browser JavaScript. The page asks for confirmation and does not update a card optimistically; the normal poll displays the value reported by the controller.

The current dashboard has no separate user login. Before enabling any writable widget, restrict port `3001` to trusted source addresses or place it behind authenticated HTTPS access. Anyone who can open an unrestricted dashboard could otherwise use its write control.

The round refresh button opens object discovery. An empty search starts at the EWS root, a container ID lists its immediate child containers and values, and a pasted full value ID is resolved through its parent container. Containers can be opened in the result list. **Dodaj** persists a selected value to `WIDGETS_FILE` and adds it to the running dashboard immediately. Discovered values are deliberately added as read-only widgets; enable writing in the widget settings when needed.

**Automatski dodaj sve vrijednosti** recursively scans the whole EWS from the root and saves all discovered value items in one batch. Existing IDs are skipped and keep their labels, visibility, precision and write permissions. Progress is synchronized through SSE; the scan continues on the server if the dialog or browser closes. At completion the dialog displays a collapsible folder/value tree with controller IDs and dashboard membership. Repeat scans add only new values. A failed or incomplete scan adds nothing. The manual search's 500-result display limit does not apply; automatic discovery stops with an explicit error if it exceeds 10,000 containers or 50,000 values. Only one automatic scan runs at a time. Scan progress and the resulting tree stay available until the dashboard server restarts; saved widgets survive restart.

The hamburger button next to discovery controls which configured widgets are shown. Turning a widget off persists `"visible": false` in `widgets.json`; it does not delete the widget and it can be turned on again at any time. Hidden writable widgets are also removed from the write dropdown. Visibility changes are applied immediately and synchronized to other open dashboard pages through SSE.

Each visible card has a cog button for editing its `label`, `description`, `unit`, optional `precision` (0–6), `writable`, and `visible` settings. Saving updates `widgets.json`, the running poller, the card, write controls, and other open dashboard pages immediately. The controller `id` is shown read-only because changing it would select a different datapoint; use discovery to add a different ID.

The same settings dialog has **Obriši widget**, followed by an explicit confirmation. Deletion removes the widget from `widgets.json`, polling, the visibility list, and write controls, and immediately updates other open dashboard pages. It only changes the dashboard configuration; the controller point remains available through discovery. The last widget can be removed too: `[]` is a valid saved configuration and survives a restart. An empty dashboard waits for new widgets without sending empty value-read requests; `/ready` remains `503` until configured points are successfully polled.

The unit controls the card symbol and colour. Supported units include `°C`, `%`, `W`/`kW`, `V`, and `A`; unknown units use a generic indicator. Widgets added through discovery appear immediately. Manual edits to `widgets.json` still require recreating the dashboard with `docker compose up -d --force-recreate dashboard` because existing configuration is loaded at startup.

`Zadnja uspješna provjera` advances after every successful poll. The `Promjena` time on an individual card advances only when the dashboard observes a different value, state, or point error; it therefore remains unchanged when a poll succeeds but the value stays the same. Card change times survive a browser refresh, but reset when the dashboard container is restarted because they are kept in memory.

`WIDGETS_JSON` remains supported and takes precedence over `WIDGETS_FILE`, primarily for deployments where mounting a file is inconvenient. Because inline environment variables cannot be edited safely at runtime, discovery is browse-only when `WIDGETS_JSON` is used.

## Portainer file configuration

Place `widgets.json` in a directory on the Docker server, for example `/opt/iot-electric/dashboard-config/`, and set these stack variables:

```env
DASHBOARD_CONFIG_SOURCE=/opt/iot-electric/dashboard-config
DASHBOARD_WIDGETS_FILE=/app/config/widgets.json
DASHBOARD_DEMO_MODE=false
```

The source path belongs to the Docker server, not the computer running the browser. The directory and `widgets.json` must be writable by the dashboard container user (UID `1000`) if the **Dodaj** action should persist changes. Set suitable ownership on the host directory before deploying the stack. A read-only Docker Config can be used for browsing, but the modal will show **Samo pregled** instead of allowing additions. A mounted password secret can still be read with `MIDDLEWARE_PASSWORD_FILE=/run/secrets/middleware_password`.

`/health` is a container liveness check. `/ready` returns `503` until a middleware poll succeeds and can be used when controller connectivity must be part of readiness.

## Docker

From the repository root:

```sh
docker compose up --build
```

The middleware is available on port `3000` and this dashboard on port `3001`.

The current test stack publishes port `3001` without dashboard login. Restrict it to a trusted network or add reverse-proxy authentication before production use.
