# ── Stage 1: compilar TypeScript ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Instala TODAS as dependências (incluindo devDeps para tsc/tsx)
COPY package*.json ./
RUN npm ci

# Compila TS → dist/
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ── Stage 2: imagem de produção ───────────────────────────────────────────────
FROM node:22-bookworm-slim

# ── Dependências de sistema ───────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── yt-dlp — binário standalone (recomendação oficial do projeto yt-dlp) ──────
RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
    -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# ── Pacotes Python ────────────────────────────────────────────────────────────
COPY requirements.txt .
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

# ── Dependências Node (somente produção) ──────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── Código compilado + assets estáticos ──────────────────────────────────────
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY assets ./assets
COPY scripts ./scripts

EXPOSE 8080
CMD ["node", "dist/src/server.js"]
