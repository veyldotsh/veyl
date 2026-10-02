FROM node:22-bookworm-slim
# Alternate development packaging only: the production installer uses systemd.
# Use host networking to retain the worker's required loopback-only binding.
ENV NODE_ENV=production BIND_HOST=127.0.0.1 PORT=4320 VEYL_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && groupadd -g 10001 veyl && useradd -r -u 10001 -g veyl veyl
COPY src ./src
COPY config/mainnet.example.json ./config/mainnet.json
COPY contracts/out ./contracts/out
RUN mkdir /data && chown -R veyl:veyl /data
USER veyl
EXPOSE 4320
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4320/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/production.mjs"]
