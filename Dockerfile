FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html ./
RUN mkdir -p data uploads
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
