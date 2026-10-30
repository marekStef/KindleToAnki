# Kindle Vocab → Anki (.apkg) — Dockerized Web App

A tiny password‑gated site to upload a Kindle `vocab.db`, pick a book, choose deck options, and download an Anki `.apkg`.

> **Desktop app (Windows & macOS):** [`desktop/`](desktop/README.md) does the same, but finds and copies
> `vocab.db` straight off a connected Kindle, including newer MTP Kindles on macOS without Amazon's USB helper.

## Features
- Password gate (set `APP_PASSWORD` in environment)
- Upload `vocab.db` (SQLite)
- Book picker with word/lookup stats
- Options: per‑word/per‑lookup, Cambridge scrape on/off, concurrency
- One‑click download of `.apkg`
- Auto‑cleanup of old uploads/outputs

## During development I used these commands:
1. `docker compose build --no-cache`
2. `docker compose up -d`
3. After another update, `docker compose down`, and back to step 1

## Quick deploy with Portainer
1. This:

```
marek@raspberrypi5:~/docker/kindleToAnki/server $ docker build -t kindle_to_anki:2.0.6 .
[+] Building 0.9s (14/14) FINISHED                                                              docker:default
 => [internal] load build definition from Dockerfile                                                      0.0s
 => => transferring dockerfile: 653B                                                                      0.0s
 => [internal] load metadata for docker.io/library/node:20-alpine                                         0.8s
 => [internal] load .dockerignore                                                                         0.0s
 => => transferring context: 76B                                                                          0.0s
 => [internal] load build context                                                                         0.0s
 => => transferring context: 289B                                                                         0.0s
 => [build 1/7] FROM docker.io/library/node:20-alpine@sha256:df02558528d3d3d0d621f112e232611aecfee7cbc65  0.0s
 => CACHED [build 2/7] WORKDIR /app                                                                       0.0s
 => CACHED [runtime 3/4] RUN apk add --no-cache sqlite-libs                                               0.0s
 => CACHED [build 3/7] RUN apk add --no-cache python3 make g++ sqlite-dev                                 0.0s
 => CACHED [build 4/7] COPY package*.json ./                                                              0.0s
 => CACHED [build 5/7] RUN npm install --omit=dev                                                         0.0s
 => CACHED [build 6/7] COPY src ./src                                                                     0.0s
 => CACHED [build 7/7] COPY public ./public                                                               0.0s
 => CACHED [runtime 4/4] COPY --from=build /app /app                                                      0.0s
 => exporting to image                                                                                    0.0s
 => => exporting layers                                                                                   0.0s
 => => writing image sha256:816d2c015213d31969520ac71754e521fcb53e7b03b8a56f5e10795af273ef5c              0.0s
 => => naming to docker.io/library/kindle_to_anki:1.0.0
 ```
2. 1.0.0 is the latest version so far
3. After that I created new stack in portainer:

With this dockerfile:

```
version: "3.9"
services:
  app:
    image: docker.io/library/kindle_to_anki:1.0.2
    container_name: kindle-to-anki
    environment:
      - TZ=Europe/Bratislava
      - APP_PASSWORD=${APP_PASSWORD}
      - PORT=8080
      - MAX_UPLOAD_MB=50
      - CLEANUP_MINUTES=60
    ports:
      - "880:8080"
    volumes:
      - data:/app/data
    restart: unless-stopped
    # If you prefer pulling from a registry, build once and push your image, then replace `build:` with `image:` only.
volumes:
  data:
```

and this .env:

```
APP_PASSWORD=marekanki
MAX_UPLOAD_MB=50
CLEANUP_MINUTES=60
TZ=Europe/Bratislava
```


## Environment variables
- `APP_PASSWORD` *(required)* — password needed to upload & download.
- `PORT` *(default 8080)* — container HTTP port.
- `MAX_UPLOAD_MB` *(default 50)* — max upload size.
- `CLEANUP_MINUTES` *(default 60)* — TTL for temporary files.
- `TZ` — timezone for logs.

## Notes on Cambridge scraping
Scraping is **best‑effort** and may break if the site changes or rate‑limits. You can disable it with the *Disable Cambridge scrape* checkbox.

https://chatgpt.com/c/68a232fe-c38c-8333-911c-9fbfb17c3cfa
