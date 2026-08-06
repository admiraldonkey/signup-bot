FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Required for proper TLS certificate validation.
RUN apk add --no-cache ca-certificates

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node --from=build /app/dist ./dist

# Versioned database migrations must exist in the runtime image.
COPY --chown=node:node drizzle ./drizzle

USER node

CMD ["node", "dist/index.js"]