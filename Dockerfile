FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/b-mikulan/IoT_Electric"
LABEL org.opencontainers.image.description="REST middleware for Schneider EcoStruxure Web Services"

WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY ["middleware/root_certificate_iotelectric.crt", "/usr/local/share/ca-certificates/iot-electric-root-ca.crt"]
RUN update-ca-certificates

ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/iot-electric-root-ca.crt

COPY package*.json ./
RUN npm ci --omit=dev

COPY middleware ./middleware

EXPOSE 3000

CMD ["node", "middleware/server.js"]
