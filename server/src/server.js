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
import Database from "better-sqlite3";

import { EventEmitter } from "node:events";

const ALLOWED_MODELS   = (process.env.OLLAMA_MODELS||"").split(/[,;\s]+/).filter(Boolean);
const MODELS_ENABLED   = ALLOWED_MODELS.length > 0;
let   MODELS_INFO      = {};
try { MODELS_INFO = JSON.parse(process.env.OLLAMA_MODELS_INFO||"{}"); } catch {}

// in-memory job registry  (id → {emitter, fileName, downloadId})
const jobs = new Map();

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
// app.set("trust proxy", false);
app.use(
  helmet({
    // serving plain HTTP in dev
    hsts: false,

    // ⬇ turn the two headers off so Chrome won’t warn
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,

    // keep your custom CSP (minus upgrade-to-HTTPS)
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'upgrade-insecure-requests': null
      }
    }
  })
);

// app.use(helmet());
app.use(morgan("tiny"));
app.use(express.json());

const dataDir = path.join(process.cwd(), "data");
const uploadDir = path.join(dataDir, "uploads");
const outDir = path.join(dataDir, "out");
await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });

// Basic rate limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 500 });
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

// ──────────────────────────────────────────────────────────────────────────────
// Jobs DB (SQLite) — data/jobs.sqlite
// ──────────────────────────────────────────────────────────────────────────────
const jobsDbPath = path.join(dataDir, "jobs.sqlite");
const jdb = new Database(jobsDbPath);
jdb.pragma("journal_mode = WAL");
jdb.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    jobId        TEXT PRIMARY KEY,
    token        TEXT NOT NULL,
    bookId       TEXT NOT NULL,
    bookTitle    TEXT,
    deckName     TEXT NOT NULL,
    includeLlm   INTEGER DEFAULT 0,
    includeSmart INTEGER DEFAULT 1,
    perWord      INTEGER DEFAULT 0,
    noScrape     INTEGER DEFAULT 0,
    concurrency  INTEGER DEFAULT 1,
    llmModel     TEXT,
    status       TEXT NOT NULL,         -- running | done | cancelled | error
    startedAt    INTEGER NOT NULL,
    endedAt      INTEGER,
    total        INTEGER,
    done         INTEGER DEFAULT 0,
    downloadId   TEXT,
    fileName     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_startedAt ON jobs(startedAt DESC);
`);
// in-place migration when the container restarts
// ── Schema upgrade: add llmModel if missing ────────────────────────────────
const hasLlmCol = jdb
  .prepare(`PRAGMA table_info(jobs)`)
  .all()
  .some(c => c.name === "llmModel");

if (!hasLlmCol) {
  try {
    jdb.exec(`ALTER TABLE jobs ADD COLUMN llmModel TEXT`);
    console.log("[db] column llmModel added");
  } catch (e) {
    // If another container/thread added it in the meantime:
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}



const sqlInsertJob = jdb.prepare(`
  INSERT INTO jobs (jobId, token, bookId, bookTitle, deckName, includeLlm, includeSmart,
                    perWord, noScrape, concurrency, llmModel, status, startedAt)
  VALUES (@jobId, @token, @bookId, @bookTitle, @deckName, @includeLlm, @includeSmart,
          @perWord, @noScrape, @concurrency, @llmModel, 'running', @startedAt)
`);
const sqlUpdateProgress = jdb.prepare(
  `UPDATE jobs SET done=@done, total=COALESCE(total,@total) WHERE jobId=@jobId`
);
const sqlFinishJob = jdb.prepare(
  `UPDATE jobs SET status=@status, endedAt=@endedAt, done=@done, total=@total,
          downloadId=@downloadId, fileName=@fileName WHERE jobId=@jobId`
);
const sqlErrorJob = jdb.prepare(
  `UPDATE jobs SET status='error', endedAt=@endedAt WHERE jobId=@jobId`
);
const sqlGetJob = jdb.prepare(`SELECT * FROM jobs WHERE jobId=?`);
const sqlListJobs = jdb.prepare(`SELECT * FROM jobs ORDER BY startedAt DESC LIMIT 200`);

const sqlCancelJob = jdb.prepare(
  `UPDATE jobs SET status='cancelled', endedAt=@endedAt WHERE jobId=@jobId`
);

function getBookMetaFromVocab(dbPath, bookId) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT title, authors FROM BOOK_INFO WHERE id = ?`).get(bookId);
    db.close();
    if (!row) return { title: "(unknown)" };
    const t = [row.title, row.authors].filter(Boolean).join(" — ");
    return { title: t || "(untitled)" };
  } catch {
    return { title: "(unknown)" };
  }
}


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
app.post("/api/convert", async (req, res, next) => {
  try {
    assert(checkPassword(req), "Unauthorized", 401);
        const {
      token, bookId, deckName,
      perWord, noScrape, concurrency,
      includeSmartVocab,
      includeLlm,
      llmModel // optional (defaults inside convert.js)
    } = req.body || {};
    assert(token, "Missing token");
    assert(bookId, "Missing bookId");
    assert(deckName, "Missing deckName");

    /* ─── strict LLM validation ───────────────────────────────────────── */
    if (includeLlm) {
      assert(MODELS_ENABLED, "LLM support is disabled on this server.", 400);
      assert(llmModel,      "No LLM model chosen.",                     400);
      assert(
        ALLOWED_MODELS.includes(llmModel),
        `Model "${llmModel}" is not allowed.`,
        400
      );
    }

    const model = includeLlm ? llmModel : undefined;

    const metaPath = path.join(uploadDir, `${token}.json`);
    const exists = await fs.access(metaPath).then(() => true).catch(() => false);
    assert(exists, "Invalid or expired token");

    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    const { title: bookTitle } = getBookMetaFromVocab(meta.path, bookId);

    // ── 1. register a job ───────────────────────────────────────────────────
    const jobId      = nanoid();
    const downloadId = nanoid();              // will name the output file
    const emitter    = new EventEmitter();
    jobs.set(jobId, { emitter, done:false, cancelled:false });

        // persist the job (status: running)
    sqlInsertJob.run({
      jobId, token, bookId, bookTitle, deckName,
      includeLlm: includeLlm ? 1 : 0,
      llmModel: model || null,
      includeSmart: includeSmartVocab !== false ? 1 : 0,
      perWord: perWord ? 1 : 0,
      noScrape: noScrape ? 1 : 0,
      concurrency: Number(concurrency ?? 1) || 1,
      startedAt: Date.now()
    });

    // ── 2. fire-and-forget worker ───────────────────────────────────────────
    (async () => {
      try {
        const buf = await buildApkg({
          dbPath: meta.path,
          bookId,
          deckName,
          perWord,
          noScrape,
          concurrency,
          includeSmartVocab: includeSmartVocab !== false, // default true
          includeLlm: !!includeLlm && !!model,
          llmModel,
          onProgress: (p) => {
            // persist progressive counts (and total on first tick)
            try {
              sqlUpdateProgress.run({ jobId, done: p.done ?? 0, total: p.total ?? null });
            } catch {}
            emitter.emit("progress", p);
          },
          emitter
        });

        // 3️⃣ save & mark done
        const safeName  = deckName.replace(/[^-\w .]/g, "_") + ".apkg";
        const outPath   = path.join(outDir, `${downloadId}__${safeName}`);
        await fs.writeFile(outPath, buf);

        emitter.emit("done", { downloadId, fileName: safeName });
        Object.assign(jobs.get(jobId), { done:true, downloadId, fileName:safeName });

        // persist completion
        try {
          const row = sqlGetJob.get(jobId);
          sqlFinishJob.run({
            jobId,
            status: "done",
            endedAt: Date.now(),
            done: row?.total ?? row?.done ?? null,
            total: row?.total ?? null,
            downloadId, fileName: safeName
          });
        } catch {}
      } catch (err) {
        if (err.message === "__CANCELLED__") {
          emitter.emit("cancelled");
          sqlCancelJob.run({ jobId, endedAt:Date.now() });
          return;                          // ↩ no “error” status
        }
        emitter.emit("error", err.message || String(err));
        try { sqlErrorJob.run({ jobId, endedAt: Date.now() }); } catch {}
      }
    })();

    // ── 4. immediate HTTP response ──────────────────────────────────────────
    res.json({ ok:true, jobId, jobUrl: `/job/${jobId}` });
  } catch (e) {
    next(e);
  }
});

// SSE progress stream
app.get("/api/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    Connection:      "keep-alive"
  });
  res.flushHeaders();

  const send = (type, data) =>
    res.write(`event:${type}\ndata:${JSON.stringify(data)}\n\n`);

  const { emitter, done, downloadId, fileName } = job;
  if (done) send("done", { downloadId, fileName });

    const startedAt = (sqlGetJob.get(req.params.id)?.startedAt) || Date.now();
  const onProgress = (p) => {
    const now = Date.now();
    const done = p.done ?? 0;
    const total = p.total ?? 0;
    const elapsedMs = now - startedAt;
    const speed = done && elapsedMs ? (done / (elapsedMs/1000)) : 0; // items/sec
    const remaining = total > 0 ? Math.max(0, total - done) : 0;
    const etaMs = speed > 0 ? Math.round((remaining / speed) * 1000) : null;
    send("progress", { ...p, elapsedMs, etaMs, speed });
  };
  const onDone     = (d) => { send("done", d); finish(); };
  const onErr      = (e) => { send("error", e); finish(); };
  const onCancel = () => { send("cancelled", {}); finish(); };

  const finish = () => {
    emitter.off("progress", onProgress);
    emitter.off("done", onDone);
    emitter.off("error", onErr);
    emitter.once("cancelled", onCancel);
    res.end();
  };

  emitter.on("progress", onProgress);
  emitter.once("done", onDone);
  emitter.once("error", onErr);
});

// Download result
app.get("/api/download/:id", async (req, res, next) => {
  try {
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

// Jobs listing (for homepage “Past jobs”)
app.get("/api/jobs", async (req, res) => {
  try {
    const rows = sqlListJobs.all().map(r => ({
      ...r,
      downloadUrl: r.downloadId ? `/api/download/${r.downloadId}` : null
    }));
    res.json({ ok:true, jobs: rows });
  } catch (e) {
    res.status(e.status || 500).json({ ok:false, error: e.message });
  }
});

// Single job (for /job/:id page header)
app.get("/api/job/:id", async (req, res) => {
  try {
    const row = sqlGetJob.get(req.params.id);
    assert(row, "Not found", 404);
    const out = {
      ...row,
      downloadUrl: row.downloadId ? `/api/download/${row.downloadId}` : null
    };
    res.json({ ok:true, job: out });
  } catch (e) {
    res.status(e.status || 500).json({ ok:false, error: e.message });
  }
});

// Serve the job details page for /job/:id
app.get("/job/:id", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "job.html"));
});

app.post("/api/job/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job)          return res.status(404).json({ ok:false, error:"Not found" });
  if (job.done)      return res.json({ ok:false, error:"Already finished" });

  job.cancelled = true;
  job.emitter.emit("cancel");          // notify the worker
  sqlCancelJob.run({ jobId:req.params.id, endedAt:Date.now() });

  res.json({ ok:true });
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

// move a finished .apkg into data/out/deleted/
async function trashJobFile(downloadId){
  const files = await fs.readdir(outDir);
  const match = files.find(f => f.startsWith(`${downloadId}__`) && f.endsWith(".apkg"));
  if (!match) return false;
  const src = path.join(outDir, match);
  const dstDir = path.join(outDir, "deleted");
  await fs.mkdir(dstDir, { recursive:true });
  await fs.rename(src, path.join(dstDir, match));
  return true;
}

// DELETE (trash) finished job
app.post("/api/job/:id/delete", requirePassword, async (req,res) => {
  const row = sqlGetJob.get(req.params.id);
  if (!row)        return res.status(404).json({ ok:false, error:"Not found" });
  if (row.status !== "done")
    return res.json({ ok:false, error:"Job is not finished yet." });

  const moved = await trashJobFile(row.downloadId);
  sqlFinishJob.run({
    jobId: row.jobId,
    status: "deleted",
    endedAt: Date.now(),
    done: row.done,
    total: row.total,
    downloadId: null,
    fileName: row.fileName
  });
  res.json({ ok:true, moved });
});

// Helper to expose catalogue to the UI
app.get("/api/llm-models", (_req,res)=>{
  if (!MODELS_ENABLED) return res.json({ok:true, models:[]});
  const list = ALLOWED_MODELS.map(id=>({id,...(MODELS_INFO[id]||{name:id,quality:"",notes:""})}));
  res.json({ok:true, models:list});
});


app.listen(PORT, () => {
  console.log(`[web] listening on :${PORT}`);
});