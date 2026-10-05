FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/
RUN npm ci --include=dev

COPY . .
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/
RUN npm ci --omit=dev

COPY backend backend
COPY --from=build /app/frontend/dist frontend/dist

RUN mkdir -p /app/backend/storage

EXPOSE 3000

CMD ["node", "backend/src/server.js"]
