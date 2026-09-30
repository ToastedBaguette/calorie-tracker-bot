FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY src ./src

CMD ["node", "src/index.js"]
