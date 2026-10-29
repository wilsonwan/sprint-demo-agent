# The agent with everything it runs: Node, Playwright's Chromium, ffmpeg, Kokoro (with its
# voice weights baked in) and cloudflared for the Share button. Logins and settings are mounted
# from the host at run time (see compose.yaml); nothing secret is in the image.

FROM node:26-bookworm-slim

ARG CLOUDFLARED_VERSION=2026.10.6
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy \
    NODE_NO_WARNINGS=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-$(dpkg --print-architecture)" \
 && chmod +x /usr/local/bin/cloudflared \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv

WORKDIR /app
RUN mkdir -p /ms-playwright /opt/uv-python /app/data && chown node:node /ms-playwright /opt/uv-python /app /app/data

# Agent dependencies, and Chromium with the system libraries it needs (root for apt).
COPY --chown=node:node package.json package-lock.json ./
RUN su node -c "npm ci --no-audit --no-fund && npm cache clean --force" \
 && npx playwright install-deps chromium \
 && su node -c "npx playwright install chromium" \
 && rm -rf /var/lib/apt/lists/*

USER node

# Kokoro: its own Python and CPU-only PyTorch, then one sentence so its weights and spaCy model
# are downloaded now instead of on the first demo.
COPY --chown=node:node tts/ tts/
RUN uv sync --frozen --project tts \
 && echo "Ready." | uv run --frozen --quiet --project tts python -I tts/speak.py /tmp/warmup.wav af_heart >/dev/null \
 && rm /tmp/warmup.wav \
 && uv cache clean

# The web app.
COPY --chown=node:node web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node web/ web/
RUN cd web && npm run build && rm -rf node_modules

COPY --chown=node:node . .

VOLUME /app/data
EXPOSE 4400
# Listens on all interfaces inside the container; publish the port on the host's loopback only
# (compose.yaml does). Requests that don't come from localhost need a share key.
CMD ["node", "--import", "tsx", "src/main.ts", "--host", "0.0.0.0", "--port", "4400"]
