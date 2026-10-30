// Keeps track of connected Kindles: scans on startup, on USB hotplug and on
// demand, and imports vocab.db (automatically when a Kindle is plugged in).

import { EventEmitter } from "node:events";
import { extractVocab, scanKindles, watchKindleHotplug } from "./kindle/index.js";
import { openVocab, summarize } from "./core/vocab.js";

const MAX_LOG_LINES = 400;

export class DeviceManager extends EventEmitter {
  /**
   * @param {{snapshots: import("./store.js").SnapshotStore, tmpDir: string, settings: () => object}} opts
   */
  constructor({ snapshots, tmpDir, settings }) {
    super();
    this.snapshots = snapshots;
    this.tmpDir = tmpDir;
    this.settings = settings;
    this.state = {
      scanning: false,
      devices: [],
      problems: [],
      lastScanAt: null,
      busy: null, // id of the device being imported
      progress: null, // { done, total } bytes while downloading over MTP
      results: {}, // deviceId -> { ok, message, hint, at }
      hotplug: false
    };
    this.logLines = [];
    this.autoImported = new Set();
    this.queue = Promise.resolve();
    this.retryTimer = null;
    this.pollTimer = null;
    this.lastProgressEmit = 0;
  }

  log(message) {
    const line = `${new Date().toLocaleTimeString()}  ${message}`;
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    this.emit("log", line);
  }

  start() {
    this.unwatch = watchKindleHotplug((type) => this.onHotplug(type));
    this.state.hotplug = Boolean(this.unwatch);
    if (!this.unwatch) {
      this.log("USB hotplug events are unavailable; scanning every 15 seconds instead.");
      this.pollTimer = setInterval(() => this.scan().catch(() => {}), 15_000);
    }
    this.scan().catch(() => {});
  }

  stop() {
    this.unwatch?.();
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
  }

  emitState() {
    this.emit("state", this.state);
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  onHotplug(type) {
    this.log(`Kindle ${type === "connect" ? "plugged in" : "unplugged"}.`);
    clearTimeout(this.retryTimer);
    // The OS needs a moment before the portable device or drive is browsable.
    const delays = type === "connect" ? [1500, 3000, 6000, 10000] : [500];
    let attempt = 0;
    const tick = async () => {
      await this.scan().catch(() => {});
      const missing = type === "connect" && !this.state.devices.some((d) => d.vocab === "found" || d.vocab === "unknown");
      if (missing && ++attempt < delays.length) this.retryTimer = setTimeout(tick, delays[attempt]);
    };
    this.retryTimer = setTimeout(tick, delays[0]);
  }

  scan() {
    return this.enqueue(async () => {
      this.state.scanning = true;
      this.emitState();
      try {
        const { devices, problems } = await scanKindles();
        const before = new Set(this.state.devices.map((d) => d.id));
        for (const d of devices) {
          if (!before.has(d.id)) this.log(`Found ${d.name} (${d.connection === "mtp" ? "MTP" : "USB drive"}${d.location ? `, ${d.location}` : ""}): vocab.db ${d.vocab}.`);
        }
        for (const p of problems) this.log(p);
        const ids = new Set(devices.map((d) => d.id));
        for (const id of [...this.autoImported]) if (!ids.has(id)) this.autoImported.delete(id); // unplugged
        Object.assign(this.state, { devices, problems, lastScanAt: Date.now() });
      } finally {
        this.state.scanning = false;
        this.emitState();
      }
      if (this.settings().autoImport) {
        for (const d of this.state.devices) {
          if (d.vocab === "missing" || this.autoImported.has(d.id)) continue;
          this.autoImported.add(d.id);
          this.import(d.id, { auto: true }).catch(() => {}); // runs after this scan; errors are shown on the device card
        }
      }
      return this.state;
    });
  }

  import(deviceId, { auto = false } = {}) {
    return this.enqueue(async () => {
      const device = this.state.devices.find((d) => d.id === deviceId);
      if (!device) throw new Error("That Kindle is no longer connected. Plug it in and click Scan.");
      this.state.busy = deviceId;
      this.state.progress = null;
      this.emitState();
      this.log(`Importing vocab.db from ${device.name}…`);
      try {
        const { bytes, method, model } = await extractVocab(device, {
          tmpDir: this.tmpDir,
          log: (m) => this.log(m),
          onProgress: (done, total) => {
            this.state.progress = { done, total };
            if (Date.now() - this.lastProgressEmit > 100) {
              this.lastProgressEmit = Date.now();
              this.emitState();
            }
          },
          releaseCameraDaemon: this.settings().releaseCameraDaemon
        });
        const db = await openVocab(bytes);
        let summary;
        try {
          summary = summarize(db);
        } finally {
          db.close();
        }
        const { snapshot, unchanged } = await this.snapshots.add(bytes, {
          deviceName: model || device.name,
          method,
          summary
        });
        const message = unchanged
          ? "Up to date: nothing new since the last import."
          : `Imported ${summary.lookups.toLocaleString()} lookups from ${summary.books.toLocaleString()} books.`;
        this.state.results[deviceId] = { ok: true, message, at: Date.now() };
        this.log(`${message} (${(bytes.length / 1024).toFixed(0)} KB via ${method})`);
        this.emit("imported", { snapshot, unchanged, auto });
        return { snapshot, unchanged };
      } catch (e) {
        this.state.results[deviceId] = { ok: false, message: e.message, hint: e.hint || null, at: Date.now() };
        this.log(`Import failed: ${e.message}${e.hint ? ` (${e.hint})` : ""}`);
        throw e;
      } finally {
        this.state.busy = null;
        this.state.progress = null;
        this.emitState();
      }
    });
  }
}
