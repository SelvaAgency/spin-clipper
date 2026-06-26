FROM node:22-bookworm-slim

# ── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── yt-dlp — instala o binário standalone (recomendado pelo projeto yt-dlp) ──
# O binário standalone é self-contained, não depende de versão do Python
# e é sempre a release mais recente estável.
RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
    -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

# ── Python packages ───────────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

# ── Node deps ─────────────────────────────────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── App source ────────────────────────────────────────────────────────────────
COPY . .
RUN npm run build 2>/dev/null || true

EXPOSE 8080
CMD ["npm", "start"]
