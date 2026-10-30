// Deck builds ("jobs"): run in the background, persisted with their logs so the
// history survives restarts, and remembered per book so later builds can skip
// words that were already exported.

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { JsonFile } from "./store.js";
import { buildDeck, CancelledError } from "./core/cards.js";
import { createExplainer } from "./core/llm.js";
import { getBook, listBooks, openVocab } from "./core/vocab.js";

const MAX_JOBS = 200;

/** Keep the user's deck name in the file name but drop characters Windows/macOS reject. */
export function safeFileName(name) {
  const cleaned = String(name || "Kindle Vocab")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 150);
  return cleaned || "Kindle Vocab";
}

async function uniquePath(dir, base, ext) {
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base}${i === 1 ? "" : ` (${i})`}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

export class JobRunner extends EventEmitter {
  constructor({ dataDir, snapshots, settings }) {
    super();
    this.snapshots = snapshots;
    this.settings = settings;
    this.logsDir = path.join(dataDir, "logs");
    this.store = new JsonFile(path.join(dataDir, "jobs.json"), { jobs: [] });
    this.running = new Map(); // jobId -> AbortController
    this.lastProgress = new Map();
    // Jobs that were running when the app quit can never finish.
    for (const j of this.store.data.jobs) {
      if (j.status === "running") Object.assign(j, { status: "error", error: "The app was closed while this job was running.", endedAt: j.endedAt || Date.now() });
    }
  }

  summary(job) {
    const { exportedIds, ...rest } = job;
    return { ...rest, exportedCount: exportedIds?.length ?? 0 };
  }

  list() {
    return this.store.data.jobs.map((j) => this.summary(j));
  }

  find(jobId) {
    return this.store.data.jobs.find((j) => j.jobId === jobId) || null;
  }

  /** Kindle IDs exported by earlier finished builds of this book. */
  exportedIdsForBook(bookId) {
    const ids = new Set();
    for (const j of this.store.data.jobs) {
      if (j.bookId === bookId && j.status === "done") for (const id of j.exportedIds || []) ids.add(id);
    }
    return [...ids];
  }

  exportedCounts() {
    const counts = {};
    for (const j of this.store.data.jobs) {
      if (j.status === "done") counts[j.bookId] = (counts[j.bookId] || 0) + (j.exportedIds?.length || 0);
    }
    return counts;
  }

  async appendLog(jobId, entry) {
    const line = { ts: Date.now(), level: "info", ...entry };
    this.emit("log", { jobId, entry: line });
    await fs.mkdir(this.logsDir, { recursive: true });
    await fs.appendFile(path.join(this.logsDir, `${jobId}.jsonl`), JSON.stringify(line) + "\n").catch(() => {});
  }

  async logs(jobId) {
    try {
      const text = await fs.readFile(path.join(this.logsDir, `${jobId}.jsonl`), "utf8");
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  update(job, patch) {
    Object.assign(job, patch);
    this.store.save();
    this.emit("update", this.summary(job));
  }

  async start(opts) {
    const settings = this.settings();
    const deckName = String(opts.deckName || "").trim();
    if (!deckName) throw new Error("Please enter a deck name.");
    const vocabBytes = await this.snapshots.read(opts.snapshotId);

    const db = await openVocab(vocabBytes);
    let book, bookWords;
    try {
      book = getBook(db, opts.bookId);
      bookWords = listBooks(db).find((b) => b.id === opts.bookId)?.unique_words ?? null;
    } finally {
      db.close();
    }
    if (!book) throw new Error("That book is not in this vocab.db.");
    const bookTitle = [book.title, book.authors].filter(Boolean).join(" — ") || "(untitled)";

    let explain = null;
    if (opts.llmModel) explain = createExplainer(settings.llm, opts.llmModel);

    const existingIds = [...new Set([...(opts.skipExported ? this.exportedIdsForBook(opts.bookId) : []), ...(opts.apkgIds || [])])];

    const job = {
      jobId: crypto.randomUUID(),
      snapshotId: opts.snapshotId,
      bookId: opts.bookId,
      bookTitle,
      deckName,
      perWord: Boolean(opts.perWord),
      scrape: opts.scrape !== false,
      includeSmartVocab: opts.includeSmartVocab !== false,
      concurrency: Math.max(1, Math.min(8, Number(opts.concurrency) || 1)),
      llmModel: opts.llmModel || null,
      skippedKnown: existingIds.length,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      total: null,
      done: 0,
      newCards: null,
      bookWords,
      apkgPath: null,
      mdPath: null,
      error: null,
      exportedIds: []
    };
    this.store.data.jobs.unshift(job);
    this.store.data.jobs.splice(MAX_JOBS);
    this.update(job, {});

    const controller = new AbortController();
    this.running.set(job.jobId, controller);
    this.run(job, { vocabBytes, explain, existingIds, signal: controller.signal, outputDir: settings.outputDir });
    return this.summary(job);
  }

  async run(job, { vocabBytes, explain, existingIds, signal, outputDir }) {
    const log = (entry) => this.appendLog(job.jobId, entry);
    log({ scope: "job", message: `Building "${job.deckName}" from ${job.bookTitle}${existingIds.length ? ` (skipping ${existingIds.length} known ids)` : ""}.` });
    try {
      const result = await buildDeck({
        vocabBytes,
        bookId: job.bookId,
        deckName: job.deckName,
        bookTitle: job.bookTitle,
        perWord: job.perWord,
        noScrape: !job.scrape,
        concurrency: job.concurrency,
        includeSmartVocab: job.includeSmartVocab,
        existingIds,
        explain,
        llmModel: job.llmModel,
        signal,
        onLog: log,
        onProgress: ({ done, total }) => {
          job.done = done;
          job.total = total;
          const now = Date.now();
          if (done === total || now - (this.lastProgress.get(job.jobId) || 0) > 150) {
            this.lastProgress.set(job.jobId, now);
            this.emit("progress", { jobId: job.jobId, done, total, startedAt: job.startedAt });
          }
        }
      });

      await fs.mkdir(outputDir, { recursive: true });
      const base = safeFileName(job.deckName);
      const apkgPath = await uniquePath(outputDir, base, ".apkg");
      await fs.writeFile(apkgPath, result.apkg);
      const mdPath = await uniquePath(outputDir, base, ".md");
      await fs.writeFile(mdPath, result.markdown, "utf8");

      await log({ scope: "job", message: `Saved ${result.newCards} cards to ${apkgPath}` });
      this.update(job, {
        status: "done",
        endedAt: Date.now(),
        newCards: result.newCards,
        exportedIds: result.exportedIds,
        apkgPath,
        mdPath,
        done: job.total ?? result.newCards
      });
    } catch (e) {
      if (e instanceof CancelledError) {
        await log({ level: "warn", scope: "job", message: "Job cancelled by user." });
        this.update(job, { status: "cancelled", endedAt: Date.now() });
      } else {
        await log({ level: "error", scope: "job", message: e.message || String(e) });
        this.update(job, { status: "error", endedAt: Date.now(), error: e.message || String(e) });
      }
    } finally {
      this.running.delete(job.jobId);
      this.lastProgress.delete(job.jobId);
    }
  }

  cancel(jobId) {
    this.running.get(jobId)?.abort();
  }

  async remove(jobId) {
    if (this.running.has(jobId)) throw new Error("Cancel the job before removing it.");
    this.store.data.jobs = this.store.data.jobs.filter((j) => j.jobId !== jobId);
    await this.store.save();
    await fs.rm(path.join(this.logsDir, `${jobId}.jsonl`), { force: true });
  }

  cancelAll() {
    for (const c of this.running.values()) c.abort();
  }
}
