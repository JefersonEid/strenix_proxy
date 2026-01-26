FROM node:20

# --------------------------------------------------
# Dependências do sistema
# --------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        yt-dlp \
        ca-certificates \
        curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# --------------------------------------------------
# App Node
# --------------------------------------------------
WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
