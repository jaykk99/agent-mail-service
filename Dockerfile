FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=3000 SMTP_PORT=2525
EXPOSE 3000 2525
CMD ["node", "server.js"]
