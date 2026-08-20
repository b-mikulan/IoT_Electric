# IoT Electric

IoT Electric contains two small services: a REST middleware for Schneider EcoStruxure Web Services (EWS) and a browser dashboard for live PLC values.

## What runs where

| Service | Folder | Local URL | Purpose |
| --- | --- | --- | --- |
| Middleware | `middleware/` | `http://localhost:3000` | Converts EWS/SOAP operations into a REST API |
| Dashboard | `dashboard/` | `http://localhost:3001` | Polls the middleware and displays live point values |

The middleware exposes public health and Swagger pages at `/health` and `/api-docs`. All `/api/*` endpoints require HTTP Basic authentication. Open Swagger and use **Authorize** before trying an API endpoint.

## Repository layout

```text
.
├── middleware/                  # Express app, EWS client, API routes and OpenAPI document
├── dashboard/                   # Independent PLC widget service and browser UI
├── test/                        # Middleware tests
├── scripts/                     # Repository maintenance helpers
├── tools/
│   ├── ews-sandbox/             # Manual EWS experiments; not used by the application
│   └── knx-extractor/            # KNX project extraction utility and legacy fixtures
├── .github/workflows/           # Test and Docker image automation
├── Dockerfile                   # Middleware image
├── docker-compose.yml           # Local/test build
└── docker-compose.portainer.yml # Deployment with published images
```

Local `.env`, `*.knxproj`, `output/`, and dependency folders are intentionally ignored. They contain credentials, local project data, generated files, or installed packages and should not be committed.

## Start locally with Docker

1. Copy `.env.example` to `.env`.
2. Install the local development and test dependencies, then generate middleware credentials:

   ```sh
   npm ci
   npm ci --prefix dashboard
   npm run auth:generate
   ```

3. Put the generated `MIDDLEWARE_USER` and `MIDDLEWARE_PASSWORD_HASH` in `.env`. Save the displayed plaintext password in a password manager; it cannot be recovered from the hash.
4. Add the controller connection:

   ```env
   EWS_URL=https://controller.example/EcoStruxure/DataExchange
   EWS_USER=controller_username
   EWS_PASSWORD=controller_password
   ```

5. Start both services:

   ```sh
   docker compose up --build
   ```

Open `http://localhost:3000/api-docs` for the API or `http://localhost:3001` for the dashboard. Dashboard demo mode is enabled by default. Real widget definitions can be kept as readable JSON in `dashboard/config/widgets.json`; see [dashboard/README.md](dashboard/README.md) for setup.

There are two separate sets of credentials:

- `EWS_USER` and `EWS_PASSWORD` let the middleware connect to a DDC controller.
- `MIDDLEWARE_USER` and its generated password let Swagger, Postman, or the dashboard call the REST API.

The dashboard needs the middleware's plaintext password because it is an API client. Keep it only in the untracked `.env`, a Portainer secret, or a Docker secret. Compose injects credentials at container start; they are not baked into either image.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the middleware |
| `npm run dev` | Start the middleware with file watching |
| `npm test` | Run middleware, tool, and dashboard tests |
| `npm run test:middleware` | Run only middleware tests |
| `npm run test:tools` | Run only development-tool tests |
| `npm run test:dashboard` | Run only dashboard tests |
| `npm run auth:generate` | Generate middleware login credentials |
| `npm run knx:extract -- project.knxproj` | Extract a KNX project into ignored `output/` |

For a non-Docker dashboard preview, install its dependencies with `npm ci --prefix dashboard` and run `npm start --prefix dashboard`.

## Docker images and Portainer

GitHub Actions tests the repository and builds both images:

- `ghcr.io/b-mikulan/iot-electric`
- `ghcr.io/b-mikulan/iot-electric-dashboard`

A push to `main` publishes `latest`, `main`, and a commit-specific tag. A Git tag such as `v1.0.0` publishes version tags. For a stable deployment, use the same exact version for both services:

```sh
git tag v1.0.0
git push origin v1.0.0
```

In Portainer, deploy `docker-compose.portainer.yml` and set `IMAGE_TAG=1.0.0`. Portainer pulls the published images directly, so the server does not need a Git clone or a manual build. Private GHCR packages require read-only package credentials in Portainer.

## Security status

The current Compose configuration is intended for an isolated test server. Basic authentication must be placed behind HTTPS in production. Port `3001` currently has no separate dashboard login, so anyone who can reach it can view telemetry. Restrict that port or put the dashboard behind an authenticated HTTPS reverse proxy before production use.

The middleware image installs the project CA certificate from `middleware/root_certificate_iotelectric.crt`. Replace it when the target controller uses a different CA. If no private CA is needed, remove the certificate `COPY`, `update-ca-certificates`, and `NODE_EXTRA_CA_CERTS` lines from the Dockerfile together.
