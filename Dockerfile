FROM node:20

# ------------------------------------------------------------------
# Dependências do sistema
# - ffmpeg: necessário para conversão (yt-dlp usa ffmpeg para extrair/convert)
# - python3 + pip: para instalar yt-dlp via pip (mais atualizado que apt)
# - ca-certificates: HTTPS
# - curl: debug/healthcheck opcional
# ------------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl && \
    pip3 install --no-cache-dir -U yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------
# App
# ------------------------------------------------------------------
WORKDIR /app

# Copiar package.json e instalar dependências Node
COPY package.json .
RUN npm install

# Copiar o restante do código (server.js etc.)
COPY . .

# Render usa PORT via env; vamos expor 3000 como padrão
EXPOSE 3000

# Start
CMD ["node", "server.js"]

