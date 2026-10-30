import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JsonFile, SnapshotStore } from "./store.js";
import { DeviceManager } from "./devices.js";
import { JobRunner } from "./jobs.js";
import { getRows, listBooks, openVocab, previewStats, summarize } from "./core/vocab.js";
import { extractIdsFromApkg } from "./core/apkgIds.js";
import { listModels } from "./core/llm.js";

const isDev = !app.isPackaged;
if (isDev && process.env.KTA_USER_DATA) app.setPath("userData", process.env.KTA_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath("userData");
let win = null;

// ── persistence ─────────────────────────────────────────────────────────────
const settingsFile = new JsonFile(path.join(userData, "settings.json"), {
  outputDir: path.join(app.getPath("documents"), "Kindle to Anki"),
  autoImport: true,
  releaseCameraDaemon: true,
  lastSnapshotId: null,
  deckNames: {},
  defaults: { perWord: false, scrape: true, includeSmartVocab: true, concurrency: 1, skipExported: true, llmModel: "" },
  llm: {
    openai: { apiKeyEnc: "", apiKeyPlain: "", models: "gpt-4o-mini, gpt-4o" },
    ollama: { url: "", models: "" }
  }
});

function decryptApiKey(openai = {}) {
  if (openai.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(openai.apiKeyEnc, "base64"));
    } catch {
      return "";
    }
  }
  return openai.apiKeyPlain || "";
}

/** Settings as the main process uses them (API key decrypted). */
function settings() {
  const s = settingsFile.data;
  return { ...s, llm: { ...s.llm, openai: { ...s.llm.openai, apiKey: decryptApiKey(s.llm.openai) } } };
}

/** Settings as shown in the UI (never contains the API key). */
function publicSettings() {
  const s = settingsFile.data;
  const { apiKeyEnc, apiKeyPlain, ...openai } = s.llm.openai;
  return { ...s, llm: { ...s.llm, openai: { ...openai, hasApiKey: Boolean(decryptApiKey(s.llm.openai)) } } };
}

async function saveSettings(patch = {}) {
  const s = settingsFile.data;
  for (const key of ["outputDir", "autoImport", "releaseCameraDaemon", "lastSnapshotId"]) {
    if (key in patch) s[key] = patch[key];
  }
  if (patch.defaults) s.defaults = { ...s.defaults, ...patch.defaults };
  if (patch.deckNames) s.deckNames = { ...s.deckNames, ...patch.deckNames };
  if (patch.llm?.openai) {
    const { apiKey, models } = patch.llm.openai;
    if (typeof models === "string") s.llm.openai.models = models;
    if (typeof apiKey === "string") {
      if (apiKey && safeStorage.isEncryptionAvailable()) {
        s.llm.openai.apiKeyEnc = safeStorage.encryptString(apiKey).toString("base64");
        s.llm.openai.apiKeyPlain = "";
      } else {
        s.llm.openai.apiKeyEnc = "";
        s.llm.openai.apiKeyPlain = apiKey;
      }
    }
  }
  if (patch.llm?.ollama) s.llm.ollama = { ...s.llm.ollama, ...patch.llm.ollama };
  await settingsFile.save();
  return publicSettings();
}

const snapshots = new SnapshotStore(path.join(userData, "snapshots"));
const devices = new DeviceManager({ snapshots, tmpDir: app.getPath("temp"), settings });
const jobs = new JobRunner({ dataDir: userData, snapshots, settings });

// Opened vocab databases, cached per snapshot (they are small and read-only).
const vocabCache = new Map();
async function vocabDb(snapshotId) {
  if (vocabCache.has(snapshotId)) return vocabCache.get(snapshotId);
  const db = await openVocab(await snapshots.read(snapshotId));
  vocabCache.set(snapshotId, db);
  for (const [id, old] of vocabCache) {
    if (vocabCache.size <= 3) break;
    if (id !== snapshotId) {
      old.close();
      vocabCache.delete(id);
    }
  }
  return db;
}

// Old decks loaded for "skip what is already in this .apkg", by token.
const apkgSets = new Map();

async function importVocabFile(filePath) {
  const bytes = await fs.readFile(filePath);
  const db = await openVocab(bytes);
  let summary;
  try {
    summary = summarize(db);
  } finally {
    db.close();
  }
  const { snapshot, unchanged } = await snapshots.add(bytes, { deviceName: path.basename(filePath), method: "File", summary });
  return { snapshot, unchanged };
}

async function loadApkg(filePath) {
  const ids = await extractIdsFromApkg(await fs.readFile(filePath));
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  apkgSets.set(token, ids);
  return { token, name: path.basename(filePath), count: ids.length };
}

function knownIds({ bookId, skipExported, apkgToken }) {
  return [...new Set([...(skipExported ? jobs.exportedIdsForBook(bookId) : []), ...(apkgSets.get(apkgToken) || [])])];
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: "Unknown sender" };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      console.error(`[ipc] ${channel}:`, e);
      return { ok: false, error: e?.message || String(e), hint: e?.hint || null };
    }
  });
}

const send = (channel, payload) => win?.webContents.send(channel, payload);

handle("app:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  userData
}));
handle("app:openDataFolder", () => shell.openPath(userData));

handle("devices:get", () => devices.state);
handle("devices:scan", () => devices.scan());
handle("devices:import", (deviceId) => devices.import(deviceId));
handle("devices:log", () => devices.logLines);

handle("vocab:openDialog", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Open a Kindle vocab.db",
    properties: ["openFile"],
    filters: [
      { name: "Kindle vocabulary (vocab.db)", extensions: ["db"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  return r.canceled || !r.filePaths[0] ? null : importVocabFile(r.filePaths[0]);
});
handle("vocab:openPath", (filePath) => importVocabFile(String(filePath)));

handle("snapshots:list", () => snapshots.list());
handle("snapshots:remove", async (id) => {
  vocabCache.get(id)?.close();
  vocabCache.delete(id);
  await snapshots.remove(id);
  return snapshots.list();
});

handle("library:load", async (snapshotId) => {
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot) throw new Error("That vocabulary snapshot no longer exists.");
  const db = await vocabDb(snapshotId);
  const exported = jobs.exportedCounts();
  await saveSettings({ lastSnapshotId: snapshotId });
  return {
    snapshot,
    summary: summarize(db),
    books: listBooks(db).map((b) => ({ ...b, exported: exported[b.id] || 0 }))
  };
});

handle("library:words", async ({ snapshotId, bookId, perWord }) => {
  const db = await vocabDb(snapshotId);
  const known = new Set(knownIds({ bookId, skipExported: true }));
  return getRows(db, bookId, perWord)
    .slice(0, 5000)
    .map((r) => ({ ...r, known: known.has(String(r.kindle_id)) }));
});

handle("library:preview", async ({ snapshotId, bookId, perWord, skipExported, apkgToken }) => {
  const db = await vocabDb(snapshotId);
  const stats = previewStats(db, { bookId, perWord, existingIds: knownIds({ bookId, skipExported, apkgToken }) });
  return { ...stats, previouslyExported: jobs.exportedIdsForBook(bookId).length };
});

handle("apkg:openDialog", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose an existing Anki deck (.apkg)",
    properties: ["openFile"],
    filters: [{ name: "Anki deck package", extensions: ["apkg"] }]
  });
  return r.canceled || !r.filePaths[0] ? null : loadApkg(r.filePaths[0]);
});
handle("apkg:openPath", (filePath) => loadApkg(String(filePath)));

handle("jobs:list", () => jobs.list());
handle("jobs:start", async (opts) => {
  const job = await jobs.start({ ...opts, apkgIds: apkgSets.get(opts.apkgToken) || [] });
  await saveSettings({
    deckNames: { [opts.bookId]: opts.deckName },
    defaults: {
      perWord: Boolean(opts.perWord),
      scrape: opts.scrape !== false,
      includeSmartVocab: opts.includeSmartVocab !== false,
      concurrency: Number(opts.concurrency) || 1,
      skipExported: Boolean(opts.skipExported),
      llmModel: opts.llmModel || ""
    }
  });
  return job;
});
handle("jobs:cancel", (jobId) => jobs.cancel(jobId));
handle("jobs:remove", async (jobId) => {
  await jobs.remove(jobId);
  return jobs.list();
});
handle("jobs:logs", (jobId) => jobs.logs(jobId));
handle("jobs:open", async ({ jobId, what }) => {
  const job = jobs.find(jobId);
  const file = what === "markdown" ? job?.mdPath : job?.apkgPath;
  if (!file) throw new Error("This job has no output file.");
  try {
    await fs.access(file);
  } catch {
    throw new Error(`The file was moved or deleted: ${file}`);
  }
  if (what === "folder") {
    shell.showItemInFolder(file);
    return null;
  }
  const err = await shell.openPath(file);
  if (err) {
    throw Object.assign(new Error(`Could not open ${path.basename(file)}: ${err}`), {
      hint: what === "apkg" ? "Is Anki installed? You can also import the file from Anki: File → Import." : null
    });
  }
  return null;
});

handle("settings:get", () => publicSettings());
handle("settings:save", (patch) => saveSettings(patch));
handle("settings:chooseOutputDir", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Where should decks be saved?",
    defaultPath: settingsFile.data.outputDir,
    properties: ["openDirectory", "createDirectory"]
  });
  if (r.canceled || !r.filePaths[0]) return publicSettings();
  return saveSettings({ outputDir: r.filePaths[0] });
});
handle("llm:models", () => listModels(settings().llm));

devices.on("state", (state) => send("devices:state", state));
devices.on("log", (line) => send("devices:log", line));
devices.on("imported", (payload) => send("library:imported", payload));
jobs.on("update", (job) => send("jobs:update", job));
jobs.on("progress", (p) => send("jobs:progress", p));
jobs.on("log", (l) => send("jobs:log", l));

// ── window ──────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    title: "Kindle to Anki",
    backgroundColor: "#0b1120",
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(import.meta.dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());

  // Links (Cambridge, docs) open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    if (jobs.running.size === 0) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Keep building", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      message: "A deck is still being built.",
      detail: "Quitting now cancels it."
    });
    if (choice === 0) e.preventDefault();
    else jobs.cancelAll();
  });
  win.on("closed", () => (win = null));

  if (isDev && process.env.KTA_DEV_SCRIPT) {
    win.webContents.once("did-finish-load", () => {
      import(pathToFileURL(process.env.KTA_DEV_SCRIPT).href)
        .then((m) => m.default({ app, win }))
        .catch((e) => console.error("[dev-script]", e));
    });
  }
}

function buildMenu() {
  if (process.platform !== "darwin") return; // the default menu (Alt) is fine on Windows/Linux
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [{ label: "Open data folder", click: () => shell.openPath(userData) }]
      }
    ])
  );
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  devices.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  devices.stop();
  jobs.cancelAll();
});
