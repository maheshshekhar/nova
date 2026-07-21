FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV PORT=3001
# Namespace whose payment-service logs are tailed (pod metrics are cluster-wide)
ENV PAYMENT_NAMESPACE=production

EXPOSE 3001

CMD ["node", "dist/index.js"]
