FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN npm install --global pnpm@12.16.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

RUN mkdir -p /app/outputs /app/work

EXPOSE 3000

CMD ["pnpm", "start"]
