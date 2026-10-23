# One image for the API (which also serves the built admin panel) and the fake infrastructure.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/infra/package.json apps/infra/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# Full source with dev dependencies: builds the web app, and runs the test suite.
FROM deps AS build
COPY . .
RUN npm run build -w apps/web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/infra/package.json apps/infra/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/infra/src apps/infra/src
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
