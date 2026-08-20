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
    "precision": 1
  }
]
```

Then keep only the connection settings in the repository-root `.env`:

```env
DASHBOARD_DEMO_MODE=false
DASHBOARD_MIDDLEWARE_PASSWORD=the_plaintext_middleware_password
DASHBOARD_WIDGETS_FILE=/app/config/widgets.json
```

Local Compose supplies `http://middleware:3000`, the shared `MIDDLEWARE_USER`, and mounts `dashboard/config/` read-only. The dashboard needs the plaintext password because it is an API client; this is the same password entered through Swagger's **Authorize** button. Keep it in the ignored root `.env`, never in the JSON file or Git.

The unit controls the card symbol and colour. Supported units include `°C`, `%`, `W`/`kW`, `V`, and `A`; unknown units use a generic indicator. After editing either file, recreate the dashboard with `docker compose up -d --force-recreate dashboard`. Widget configuration is loaded once at startup.

`Zadnja uspješna provjera` advances after every successful poll. The `Promjena` time on an individual card advances only when the dashboard observes a different value, state, or point error; it therefore remains unchanged when a poll succeeds but the value stays the same. Card change times survive a browser refresh, but reset when the dashboard container is restarted because they are kept in memory.

`WIDGETS_JSON` remains supported and takes precedence over `WIDGETS_FILE`, primarily for deployments where mounting a file is inconvenient.

## Portainer file configuration

Place `widgets.json` in a directory on the Docker server, for example `/opt/iot-electric/dashboard-config/`, and set these stack variables:

```env
DASHBOARD_CONFIG_SOURCE=/opt/iot-electric/dashboard-config
DASHBOARD_WIDGETS_FILE=/app/config/widgets.json
DASHBOARD_DEMO_MODE=false
```

The source path belongs to the Docker server, not the computer running the browser. A Portainer or Docker Config mounted at `/app/config/widgets.json` works as well. A mounted password secret can still be read with `MIDDLEWARE_PASSWORD_FILE=/run/secrets/middleware_password`.

`/health` is a container liveness check. `/ready` returns `503` until a middleware poll succeeds and can be used when controller connectivity must be part of readiness.

## Docker

From the repository root:

```sh
docker compose up --build
```

The middleware is available on port `3000` and this dashboard on port `3001`.

The current test stack publishes port `3001` without dashboard login. Restrict it to a trusted network or add reverse-proxy authentication before production use.
