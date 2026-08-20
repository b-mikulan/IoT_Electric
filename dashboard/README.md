# IoT Electric PLC dashboard

This is the second, independent Node.js service. It polls the protected DDC middleware, detects changed values with `EventEmitter`, and pushes only those changes to open browsers over Server-Sent Events. The browser never receives the middleware username or password.

## Quick preview

```sh
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3001`. Demo mode is enabled by default and is visibly marked in the interface.

## Connect real PLC points

Set these values in `.env` or in the Portainer container environment:

```env
DEMO_MODE=false
MIDDLEWARE_URL=http://middleware:3000
MIDDLEWARE_USER=middleware-admin
MIDDLEWARE_PASSWORD=the_plaintext_password_for_that_middleware_user
POLL_INTERVAL_MS=15000
MIDDLEWARE_TIMEOUT_MS=10000
WIDGETS_JSON=[{"id":"01/ES/Building/Temperature","label":"Temperatura ureda","description":"Ured · prizemlje","unit":"°C","precision":1}]
```

`id` must match the DDC value identifier accepted by `POST /api/values/read`. The unit controls the card symbol and colour. Supported units include `°C`, `%`, `W`/`kW`, `V`, and `A`; unknown units use a generic indicator.

For the test server, Docker Compose supplies `http://middleware:3000` as the middleware URL. Use the same middleware credentials you enter through Swagger's **Authorize** button. The dashboard needs the plaintext password because it is an API client; keep it in Portainer or another secret store, never in Git. A mounted secret can be read with `MIDDLEWARE_PASSWORD_FILE=/run/secrets/middleware_password` instead of `MIDDLEWARE_PASSWORD`.

`/health` is a container liveness check. `/ready` returns `503` until a middleware poll succeeds and can be used when controller connectivity must be part of readiness.

## Docker

From the repository root:

```sh
docker compose up --build
```

The middleware is available on port `3000` and this dashboard on port `3001`.

The current test stack publishes port `3001` without dashboard login. Restrict it to a trusted network or add reverse-proxy authentication before production use.
