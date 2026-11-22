FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY dist ./dist
RUN npm run build

ENV NODE_ENV=production
USER node
EXPOSE 4173
CMD ["node", "server/http.mjs"]
