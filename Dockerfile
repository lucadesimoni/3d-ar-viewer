# --- Build stage: compile the app ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime stage: serve the static build with the zero-dependency server ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
# Only the built output and the server are needed at runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# For AR on a device, terminate TLS at a proxy or pass --https with mounted certs.
CMD ["node", "server/serve.mjs"]
