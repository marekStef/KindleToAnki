# Kindle Vocab → Anki (.apkg) — Dockerized Web App

A tiny password‑gated site to upload a Kindle `vocab.db`, pick a book, choose deck options, and download an Anki `.apkg`.

## Features
- Password gate (set `APP_PASSWORD` in environment)
- Upload `vocab.db` (SQLite)
- Book picker with word/lookup stats
- Options: per‑word/per‑lookup, Cambridge scrape on/off, concurrency
- One‑click download of `.apkg`
- Auto‑cleanup of old uploads/outputs

## Quick deploy with Portainer
1. **Create a new Stack** → *Web editor*.
2. Paste the contents of `docker-compose.yml`.
3. Add an **Environment variable** in the stack editor: `APP_PASSWORD` (required).
4. **Deploy the Stack**.
5. Visit `http://<your-host>:8080` (or behind your reverse proxy/domain).

> To change the port, edit `ports:` or set `PORT` env.

## Environment variables
- `APP_PASSWORD` *(required)* — password needed to upload & download.
- `PORT` *(default 8080)* — container HTTP port.
- `MAX_UPLOAD_MB` *(default 50)* — max upload size.
- `CLEANUP_MINUTES` *(default 60)* — TTL for temporary files.
- `TZ` — timezone for logs.

## Reverse proxy / TLS
Put this behind Caddy/Traefik/Nginx for HTTPS. Only the single container is needed.

## Notes on Cambridge scraping
Scraping is **best‑effort** and may break if the site changes or rate‑limits. You can disable it with the *Disable Cambridge scrape* checkbox.

## Local dev
```bash
cd server
npm ci
APP_PASSWORD=devpass node src/server.js
# open http://localhost:8080