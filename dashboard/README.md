# IoT Electric PLC dashboard

This is the second, independent Node.js service. It polls the protected DDC middleware, detects changed values with `EventEmitter`, and pushes only those changes to open browsers over Server-Sent Events. The browser never receives the middleware username or password.

## Quick preview

```sh
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3001`. Demo mode is enabled by default and is visibly marked in the interface.

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

The round refresh button opens object discovery. An empty search starts at the EWS root, a container ID lists its immediate child containers and values, and a pasted full value ID is resolved through its parent container. Containers can be opened in the result list. **Dodaj** persists a selected value to `WIDGETS_FILE` and adds it to the running dashboard immediately. Discovered values are deliberately added as read-only widgets; add `"writable": true` manually only after confirming that writes should be allowed.

The hamburger button next to discovery controls which configured widgets are shown. Turning a widget off persists `"visible": false` in `widgets.json`; it does not delete the widget and it can be turned on again at any time. Hidden writable widgets are also removed from the write dropdown. Visibility changes are applied immediately and synchronized to other open dashboard pages through SSE.

Each visible card has a cog button for editing its `label`, `description`, `unit`, optional `precision` (0–6), `writable`, and `visible` settings. Saving updates `widgets.json`, the running poller, the card, write controls, and other open dashboard pages immediately. The controller `id` is shown read-only because changing it would select a different datapoint; use discovery to add a different ID.

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
