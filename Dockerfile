FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8788

COPY package.json ./
COPY src ./src

EXPOSE 8788
CMD ["node", "src/node-server.mjs"]
