FROM node:22 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY client/package.json client/package-lock.json client/
RUN cd client && npm install

COPY . .
RUN npm run build


# Node 22+: better-sqlite3's native addon crashes on an older ABI rather
# than erroring cleanly (same floor as lib-node-runtime.sh and CI).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/client/dist ./client/dist

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["npm", "start"]
