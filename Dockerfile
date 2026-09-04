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
# For AR on a device, terminate TLS at a proxy or pass --https with mounted certs.
CMD ["node", "server/serve.mjs"]
