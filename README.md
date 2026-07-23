# IoT_Electric
All files related to work at IoT Electric


Run npm install to get dependencies
  - adm-zip
  - fast-xml-parser


## Docker

Build and run the service with Docker Compose:

1. Create a `credentials.txt` file in the repo root with these lines:

```sh
EWS_USER=your_username
EWS_PASSWORD=your_password
```

2. Run:

```sh
docker compose up --build
```

The app listens on port `3000`. The secret file is mounted into the container at runtime and read by `entrypoint.sh`, so credentials do not need to be baked into the image.



XML to JSON extraction works correctly on Bruno 1.knxproj and Bruno2.knxproj.