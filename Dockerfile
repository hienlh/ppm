FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY dist/ ./dist/
COPY src/ ./src/
EXPOSE 8080
CMD ["bun", "run", "src/index.ts", "start"]
