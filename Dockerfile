FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV VITE_ENABLE_VERCEL_ANALYTICS=0
ENV LOCAL_API_CLOUD_FALLBACK=false
ENV LOCAL_WEB_HOST=0.0.0.0
ENV LOCAL_WEB_PORT=3000

EXPOSE 3000

CMD ["npm", "run", "local:web"]

