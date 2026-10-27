FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DB_PATH=/data/shop.db COOKIE_SECURE=true TRUST_PROXY=true
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
