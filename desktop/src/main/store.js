// Local persistence in the app's userData folder:
//   settings.json            user settings (API key encrypted with the OS keychain)
//   snapshots/index.json     every vocab.db we pulled off a Kindle (or opened)
//   snapshots/<id>.db
//   jobs.json                build history
//   logs/<jobId>.jsonl       per-job log lines

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

export class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.queue = Promise.resolve();
    try {
      this.data = { ...structuredClone(defaults), ...JSON.parse(fsSync.readFileSync(file, "utf8")) };
    } catch {
      this.data = structuredClone(defaults);
    }
  }
  save() {
    const json = JSON.stringify(this.data, null, 2);
    this.queue = this.queue.then(() => writeAtomic(this.file, json)).catch((e) => console.error(`[store] ${this.file}: ${e.message}`));
    return this.queue;
  }
}

const MAX_SNAPSHOTS = 25;

export class SnapshotStore {
  constructor(dir) {
    this.dir = dir;
    this.index = new JsonFile(path.join(dir, "index.json"), { snapshots: [] });
  }

  list() {
    return [...this.index.data.snapshots].sort((a, b) => b.importedAt - a.importedAt);
  }

  get(id) {
    return this.index.data.snapshots.find((s) => s.id === id) || null;
  }

  async read(id) {
    const snap = this.get(id);
    if (!snap) throw new Error("That vocabulary snapshot no longer exists.");
    return fs.readFile(path.join(this.dir, snap.file));
  }

  /** Store a vocab.db copy; identical content is stored only once (its entry is refreshed). */
  async add(bytes, meta) {
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const existing = this.index.data.snapshots.find((s) => s.sha256 === sha256);
    if (existing) {
      Object.assign(existing, meta, { importedAt: Date.now() });
      await this.index.save();
      return { snapshot: existing, unchanged: true };
    }
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${sha256.slice(0, 8)}`;
    const snapshot = { id, file: `${id}.db`, sha256, size: bytes.length, importedAt: Date.now(), ...meta };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, snapshot.file), bytes);
    this.index.data.snapshots.push(snapshot);
    await this.prune();
    await this.index.save();
    return { snapshot, unchanged: false };
  }

  async remove(id) {
    const snap = this.get(id);
    if (!snap) return;
    this.index.data.snapshots = this.index.data.snapshots.filter((s) => s.id !== id);
    await this.index.save();
    await fs.rm(path.join(this.dir, snap.file), { force: true });
  }

  async prune() {
    const sorted = this.list();
    for (const old of sorted.slice(MAX_SNAPSHOTS)) {
      this.index.data.snapshots = this.index.data.snapshots.filter((s) => s.id !== old.id);
      await fs.rm(path.join(this.dir, old.file), { force: true }).catch(() => {});
    }
  }
}
