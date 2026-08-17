FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY ["ddc kontroler/root_certificate_iotelectric.crt", "/usr/local/share/ca-certificates/iot-electric-root-ca.crt"]
RUN update-ca-certificates

ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/iot-electric-root-ca.crt

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "ddc kontroler/server.js"]
