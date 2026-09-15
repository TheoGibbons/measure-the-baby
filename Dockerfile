FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/growth.sqlite

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]

# Traefik routes only to a healthy container, so these timings are what make a
# LIVE deploy seamless (scripts/deploy.sh). --start-interval probes every second
# while booting, so a new release takes traffic as soon as it answers. The short
# --interval and the /tmp/drain check let a deploy take the outgoing release out
# of rotation within 15 seconds, before it is stopped.
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --start-interval=1s --retries=3 \
  CMD test ! -f /tmp/drain && wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.mjs"]
