# syntax=docker/dockerfile:1.7
# --- Build stage: compile the app ---
# Node 22, as CI uses: the toolchain (jsdom 30, Vite 8) needs it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm can crash mid-download with "Exit handler never called" and still exit
# 0, leaving a half-installed node_modules for the next step to trip over. So
# the install is checked, not trusted. Behind a TLS-inspecting proxy, pass its
# CA as a build secret (`--secret id=ca,src=ca.pem`); it is never stored in
# the image.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund && test -x node_modules/.bin/vite && test -x node_modules/.bin/tsc
COPY . .
# There is no .git in the build context: the commit comes in as an argument,
# so a diagnostics report from this image still says which build it is.
ARG BUILD_COMMIT=unknown
ENV BUILD_COMMIT=$BUILD_COMMIT
RUN npm run build

# --- Runtime stage: serve the static build with the zero-dependency server ---
FROM node:22-alpine AS runtime
ARG VERSION=0.0.0
ARG BUILD_COMMIT=unknown
LABEL org.opencontainers.image.title="Spatial Assembly AR" \
      org.opencontainers.image.description="Guided-assembly AR viewer: the built web app and its zero-dependency server." \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/lucadesimoni/3d-ar-viewer" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$BUILD_COMMIT
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
# Only the built output and the server are needed at runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# Not root: the server only reads files and listens on an unprivileged port.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# For AR on a device, terminate TLS at a proxy or pass --https with mounted certs.
CMD ["node", "server/serve.mjs"]
