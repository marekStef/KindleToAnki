import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import multer from "multer";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
import { env, toInt, assert } from "./util.js";
import { listBooksFromVocab, buildApkg } from "./convert.js";

const APP_PASSWORD = env("APP_PASSWORD");
const PORT = toInt(env("PORT"), 8080);
const MAX_UPLOAD_MB = toInt(env("MAX_UPLOAD_MB"), 50);
const CLEANUP_MINUTES = toInt(env("CLEANUP_MINUTES"), 60);

if (!APP_PASSWORD) {
  console.error("[FATAL] APP_PASSWORD is not set. Provide it via environment or .env.");
  process.exit(1);
}

function requirePassword(req, res, next) {
  // headers & query are accessible without body parsing
  const ok = String(req.headers["x-app-password"] || req.query?.password || "") === String(APP_PASSWORD);
  if (!ok) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

const app = express();
app.set("trust proxy", true);
app.use(helmet({
  // we're serving plain HTTP, so don't tell browsers to force HTTPS
  hsts: false,
  // remove the CSP auto-upgrade that nudges HTTPS
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "upgrade-insecure-requests": null
    }
  }
}));

// app.use(helmet());
app.use(morgan("tiny"));
app.use(express.json());

const dataDir = path.join(process.cwd(), "data");
const uploadDir = path.join(dataDir, "uploads");
const outDir = path.join(dataDir, "out");
await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });

// Basic rate limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

// Static frontend
app.use(express.static(path.join(process.cwd(), "public")));

// Multer for file uploads
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 }
});

function checkPassword(req) {
  const p = req.body?.password || req.headers["x-app-password"] || req.query?.password;
  return String(p || "") === String(APP_PASSWORD);
}

// ---- API ----

// Upload vocab.db, return token + book list
app.post("/api/upload", requirePassword, upload.single("db"), async (req, res, next) => {
  try {
    assert(req.file, "Missing file 'db' (SQLite vocab.db)");

    // sanity: ensure it's a Kindle vocab db
    let books;
    try {
      books = listBooksFromVocab(req.file.path);
    } catch (e) {
      // clean bad upload
      await fs.rm(req.file.path, { force: true });
      throw new Error("Uploaded file is not a valid Kindle vocab.db");
    }

    const token = nanoid();
    const meta = { token, path: req.file.path, createdAt: Date.now() };
    await fs.writeFile(path.join(uploadDir, `${token}.json`), JSON.stringify(meta), "utf8");

    res.json({ ok: true, token, books });
  } catch (e) {
    next(e);
  }
});

// Convert request: requires token, bookId, deckName, options
app.post("/api/convert", express.json(), async (req, res, next) => {
  try {
    assert(checkPassword(req), "Unauthorized", 401);
    const { token, bookId, deckName, perWord, noScrape, concurrency } = req.body || {};
    assert(token, "Missing token");
    assert(bookId, "Missing bookId");
    assert(deckName, "Missing deckName");

    const metaPath = path.join(uploadDir, `${token}.json`);
    const exists = await fs.access(metaPath).then(() => true).catch(() => false);
    assert(exists, "Invalid or expired token");

    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));

    const buf = await buildApkg({
      dbPath: meta.path,
      bookId,
      deckName,
      perWord: !!perWord,
      noScrape: !!noScrape,
      concurrency: toInt(concurrency, 4)
    });

    const downloadId = nanoid();
    const fileNameSafe = deckName.replace(/[\\/:*?"<>|]/g, "_") || "Kindle_Vocab";
    const outPath = path.join(outDir, `${downloadId}__${fileNameSafe}.apkg`);
    await fs.writeFile(outPath, buf);

    res.json({ ok: true, downloadId, fileName: `${fileNameSafe}.apkg` });
  } catch (e) {
    next(e);
  }
});

// Download result
app.get("/api/download/:id", async (req, res, next) => {
  try {
    assert(checkPassword(req), "Unauthorized", 401);
    const id = req.params.id;
    const files = await fs.readdir(outDir);
    const match = files.find((f) => f.startsWith(`${id}__`) && f.endsWith(".apkg"));
    assert(match, "Not found", 404);
    const full = path.join(outDir, match);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${match.split("__")[1]}"`);
    res.sendFile(full);
  } catch (e) {
    next(e);
  }
});

// Simple health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Error handler
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ ok: false, error: err.message || "Server error" });
});

// Background cleanup (uploads & outputs)
const MIN = 60 * 1000;
const TTL = CLEANUP_MINUTES * MIN;
setInterval(async () => {
  const now = Date.now();
  // Clean upload metas & files
  for (const dir of [uploadDir, outDir]) {
    const list = await fs.readdir(dir).catch(() => []);
    for (const f of list) {
      try {
        const full = path.join(dir, f);
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > TTL) {
          await fs.rm(full, { force: true, recursive: false });
        }
      } catch {}
    }
  }
}, 5 * MIN);

app.listen(PORT, () => {
  console.log(`[web] listening on :${PORT}`);
});