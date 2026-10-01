#===============
# DOCKERFILE - HELLYADDON
# Minimal Alpine footprint, strips out development dependencies, 
# and automatically pulls the loading screen MP4s directly into the static folder.
#===============
FROM node:20-alpine

LABEL org.opencontainers.image.title="HellyAddon" \
      org.opencontainers.image.description="Stremio anime streams addon with Anime Garden, exact title matching, and Debrid optimizations" \
      org.opencontainers.image.source="https://github.com/yhh-1213/animegarden-aiostreams-addon"

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p static && \
    wget -q -O static/waiting.mp4 "https://github.com/mralanbourne/Yomi/releases/download/video/waiting.mp4" && \
    wget -q -O static/archive.mp4 "https://github.com/mralanbourne/Yomi/releases/download/video/archive.mp4"

EXPOSE 7002

CMD ["npm", "start"]
