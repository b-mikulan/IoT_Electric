FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/b-mikulan/IoT_Electric"
LABEL org.opencontainers.image.description="Live widget dashboard for IoT Electric DDC values"

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY app.js server.js ./
COPY lib ./lib
COPY public ./public

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
