FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/b-mikulan/IoT_Electric"
LABEL org.opencontainers.image.description="Live widget dashboard for IoT Electric DDC values"

WORKDIR /app/dashboard
ENV NODE_ENV=production
ENV DASHBOARD_DB_FILE=/app/config/dashboard.sqlite

COPY dashboard/package*.json ./
RUN apk add --no-cache python3 && npm ci --omit=dev

COPY dashboard/app.js dashboard/server.js ./
COPY dashboard/lib ./lib
COPY dashboard/public ./public
COPY catalog /app/catalog
COPY tools/ews-topology/map_topology.py tools/ews-topology/pruning.py tools/ews-topology/admin_scan.py /app/tools/ews-topology/

WORKDIR /app
RUN mkdir -p /app/config && chown node:node /app/config \
    && ln -s /app/config /app/dashboard/config

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dashboard/server.js"]
