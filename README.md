# IoT_Electric
All files related to work at IoT Electric


Run npm install to get dependencies
  - adm-zip
  - fast-xml-parser


## Docker

Build and run the service with Docker Compose:

1. Copy `.env.example` to `.env` in the repository root.

2. Set the controller credentials and, if necessary, override its EWS URL:

```sh
EWS_USER=your_username
EWS_PASSWORD=your_password
# EWS_URL=https://controller.example/EcoStruxure/DataExchange
```

3. Build and start the container:

```sh
docker compose up --build
```

The app listens on port `3000`. Docker Compose reads `.env` at deployment time and injects its values into the container environment. The `.env` file is excluded from Git and from the Docker build context, so it is not committed or baked into the image.



XML to JSON extraction works correctly on Bruno 1.knxproj and Bruno2.knxproj.
