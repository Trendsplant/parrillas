FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 nodeapp \
  && useradd --system --uid 1001 --gid nodeapp --create-home nodeapp
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=nodeapp:nodeapp package.json server.js ./
COPY --chown=nodeapp:nodeapp api ./api
COPY --chown=nodeapp:nodeapp data ./data
COPY --chown=nodeapp:nodeapp public ./public
USER nodeapp
EXPOSE 3000
CMD ["node", "server.js"]

