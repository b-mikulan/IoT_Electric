# IoT_Electric
All files related to work at IoT Electric


Run npm install to get dependencies
  - adm-zip
  - fast-xml-parser


## Docker

Build and run the service with Docker Compose:

1. Copy `.env.example` to `.env` in the repository root.

2. Generate a separate username and password for access to the middleware:

```sh
npm run auth:generate
```

Save the generated password in a password manager. Copy only the generated `MIDDLEWARE_USER` and `MIDDLEWARE_PASSWORD_HASH` values into `.env`.

3. Set the controller credentials and, if necessary, override its EWS URL:

```sh
EWS_USER=your_username
EWS_PASSWORD=your_password
MIDDLEWARE_USER=middleware-admin
MIDDLEWARE_PASSWORD_HASH=scrypt:generated_salt:generated_hash
# EWS_URL=https://controller.example/EcoStruxure/DataExchange
```

The middleware credentials protect the REST API and Swagger UI. They are separate from `EWS_USER` and `EWS_PASSWORD`, which the middleware uses to authenticate to the DDC controller.

4. Build and start the container:

```sh
docker compose up --build
```

The app listens on port `3000`. `/api-docs` is public so the API documentation can be viewed without signing in. Use Swagger's **Authorize** button before calling protected `/api` endpoints. API clients such as Postman should use the same credentials with HTTP Basic authentication. `/health` also remains available without authentication for container health checks.

Docker Compose reads `.env` at deployment time and injects its values into the container environment. The `.env` file is excluded from Git and from the Docker build context, so it is not committed or baked into the image.

Basic authentication must use HTTPS in production because its credentials are only Base64-encoded. The current plain-HTTP setup is suitable only for isolated testing with non-production credentials.

## DDC middleware structure

The Express middleware is split by responsibility:

```text
ddc kontroler/
├── server.js                 # Loads configuration and starts the HTTP server
├── app.js                    # Creates and configures the Express application
├── ewsClient.js              # Communicates with the EcoStruxure EWS service
├── middlewareAuth.js         # Verifies middleware Basic authentication
├── swaggerDocument.js        # OpenAPI document used by Swagger UI
├── middleware/
│   └── errorHandler.js       # Final Express error response handler
└── routes/
    ├── index.js              # Combines all API routers
    ├── coreRoutes.js         # Service information and containers
    ├── dataRoutes.js         # Values, items, enums and hierarchy
    ├── alarmRoutes.js        # Current alarms and alarm history
    ├── historyRoutes.js      # Value history
    ├── subscriptionRoutes.js # Subscription lifecycle
    └── routeUtils.js         # Shared route validation/error helpers
```

All API routers are mounted below `/api`, so their public URLs remain unchanged.
