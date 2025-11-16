FROM node:20

# Instalar ffmpeg (agora funciona!)
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean

# Criar diretório do app
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package.json .
RUN npm install

# Copiar código restante
COPY . .

# Expor porta da Render
EXPOSE 3000

# Comando que inicia seu servidor
CMD ["node", "server.js"]

