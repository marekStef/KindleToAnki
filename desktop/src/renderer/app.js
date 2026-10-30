const api = window.kta;

// ── helpers ─────────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => Number(n || 0).toLocaleString();
const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
  return fmtDate(ts);
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function hue(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function initials(title) {
  const words = String(title || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const significant = words.filter((w) => !/^(the|a|an)$/i.test(w));
  return (significant.length ? significant : words).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

const normalize = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function toast(message, { kind = "info", hint = null, actions = [], timeout = 6000 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${esc(message)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ""}`;
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "toast-actions";
    for (const a of actions) {
      const b = document.createElement("button");
      b.className = "btn btn-ghost btn-sm";
      b.textContent = a.label;
      b.onclick = () => {
        a.run();
        el.remove();
      };
      row.append(b);
    }
    el.append(row);
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? Math.max(timeout, 10000) : timeout);
}

const showError = (e) => toast(e?.message || String(e), { kind: "err", hint: e?.hint });

// ── state ───────────────────────────────────────────────────────────────────
const state = {
  info: null,
  settings: null,
  models: [],
  devices: { devices: [], problems: [], results: {}, busy: null, scanning: false },
  snapshots: [],
  library: null, // { snapshot, summary, books }
  loadingSnapshotId: null,
  selectedBookId: null,
  pane: "options",
  words: null,
  apkg: null, // { token, name, count }
  jobs: [],
  sessionJobs: new Set(),
  openLogs: new Map() // jobId -> entries for expanded logs on the Decks page
};

const selectedBook = () => state.library?.books.find((b) => b.id === state.selectedBookId) || null;

// ── tabs ────────────────────────────────────────────────────────────────────
function showView(name) {
  for (const t of $$(".tab")) t.classList.toggle("active", t.dataset.view === name);
  for (const v of $$(".view")) v.classList.toggle("active", v.id === `view-${name}`);
  if (name === "settings") refreshDeviceLog();
}
for (const t of $$(".tab")) t.addEventListener("click", () => showView(t.dataset.view));

// ── devices ─────────────────────────────────────────────────────────────────
const KINDLE_ICON = `<svg class="device-icon" viewBox="0 0 34 44" aria-hidden="true"><rect x="2" y="2" width="30" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6.5" y="6.5" width="21" height="27" rx="1.5" fill="currentColor" opacity=".16"/><circle cx="17" cy="38" r="1.6" fill="currentColor"/></svg>`;

function renderDevices() {
  const { devices, problems, results, busy, scanning, progress } = state.devices;
  $("#scanBtn").classList.toggle("spinning", Boolean(scanning));
  const list = $("#deviceList");

  if (!devices.length) {
    list.innerHTML = `<div class="no-device">
      <strong>${scanning ? "Looking for your Kindle…" : "No Kindle connected"}</strong>
      <span>Connect it with a USB cable and keep it unlocked. Both USB-drive and MTP (2022+) Kindles work.</span>
    </div>`;
  } else {
    list.innerHTML = devices
      .map((d) => {
        const r = results[d.id];
        const isBusy = busy === d.id;
        const statusDot = d.vocab === "found" ? "ok" : d.vocab === "missing" ? "warn" : "";
        const statusText =
          d.vocab === "found"
            ? `vocab.db found${d.vocabSize ? ` · ${fmtBytes(d.vocabSize)}` : ""}`
            : d.vocab === "missing"
              ? "vocab.db not found"
              : "Ready to import";
        const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
        return `<div class="device ${d.vocab === "found" ? "found" : ""}">
          ${KINDLE_ICON}
          <div>
            <div class="device-name">${esc(d.name)}</div>
            <div class="device-sub">${d.connection === "mtp" ? "MTP" : "USB drive"}${d.location ? ` · ${esc(d.location)}` : ""}</div>
            <div class="device-status"><span class="dot ${statusDot}"></span>${esc(statusText)}</div>
          </div>
          ${d.note ? `<div class="device-note">${esc(d.note)}</div>` : ""}
          ${isBusy ? (pct == null ? `<div class="progress indeterminate"><div></div></div>` : `<div class="progress"><div style="width:${pct}%"></div></div>`) : ""}
          ${
            r && !isBusy
              ? `<div class="device-result ${r.ok ? "ok" : "err"}">${esc(r.message)}${r.hint ? `<span class="hint">${esc(r.hint)}</span>` : ""}</div>`
              : ""
          }
          <div class="device-actions">
            <button class="btn ${d.vocab === "missing" ? "btn-ghost" : "btn-primary"} btn-sm" data-import="${esc(d.id)}" ${busy ? "disabled" : ""}>
              ${isBusy ? "Importing…" : r?.ok ? "Import again" : "Import vocabulary"}
            </button>
          </div>
        </div>`;
      })
      .join("");
  }

  const probs = $("#deviceProblems");
  probs.hidden = !problems?.length;
  probs.textContent = (problems || []).join(" ");

  const importing = devices.find((d) => d.id === busy);
  $("#emptyTitle").textContent = importing ? `Reading vocab.db from ${importing.name}…` : "Plug in your Kindle";
}

$("#deviceList").addEventListener("click", async (e) => {
  const id = e.target.closest("[data-import]")?.dataset.import;
  if (!id) return;
  try {
    const { snapshot, unchanged } = await api.devices.import(id);
    await loadLibrary(snapshot.id);
    toast(unchanged ? "Vocabulary is up to date." : "Vocabulary imported from your Kindle.", { kind: "ok" });
  } catch (err) {
    showError(err);
  }
});

$("#scanBtn").addEventListener("click", () => api.devices.scan().catch(showError));

// ── snapshots ───────────────────────────────────────────────────────────────
async function refreshSnapshots() {
  state.snapshots = await api.snapshots.list();
  renderSnapshots();
}

function renderSnapshots() {
  const list = $("#snapshotList");
  if (!state.snapshots.length) {
    list.innerHTML = `<div class="empty-small">Nothing imported yet.</div>`;
    return;
  }
  const activeId = state.library?.snapshot.id;
  list.innerHTML = state.snapshots
    .map(
      (s) => `<div class="snapshot ${s.id === activeId ? "active" : ""}" data-snapshot="${esc(s.id)}" role="button" tabindex="0" title="${esc(`${s.method} · ${new Date(s.importedAt).toLocaleString()}`)}">
        <span class="snapshot-name">${esc(s.deviceName || "vocab.db")}</span>
        <button class="icon-btn snapshot-remove" data-remove-snapshot="${esc(s.id)}" title="Remove this copy" aria-label="Remove">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <span class="snapshot-meta">${esc(timeAgo(s.importedAt))}${s.summary ? ` · ${plural(s.summary.lookups, "lookup")}` : ""}</span>
      </div>`
    )
    .join("");
}

$("#snapshotList").addEventListener("click", async (e) => {
  const removeId = e.target.closest("[data-remove-snapshot]")?.dataset.removeSnapshot;
  if (removeId) {
    e.stopPropagation();
    try {
      state.snapshots = await api.snapshots.remove(removeId);
      if (state.library?.snapshot.id === removeId) {
        state.library = null;
        state.selectedBookId = null;
        if (state.snapshots[0]) await loadLibrary(state.snapshots[0].id);
        else renderLibrary();
      }
      renderSnapshots();
    } catch (err) {
      showError(err);
    }
    return;
  }
  const id = e.target.closest("[data-snapshot]")?.dataset.snapshot;
  if (id && id !== state.library?.snapshot.id) loadLibrary(id).catch(showError);
});

async function openVocabDialog() {
  try {
    const res = await api.vocab.openDialog();
    if (res) await loadLibrary(res.snapshot.id);
  } catch (e) {
    showError(e);
  }
}
$("#openVocabBtn").addEventListener("click", openVocabDialog);
$("#openVocabBtn2").addEventListener("click", openVocabDialog);

// ── library ─────────────────────────────────────────────────────────────────
async function loadLibrary(snapshotId) {
  if (state.loadingSnapshotId === snapshotId) return;
  state.loadingSnapshotId = snapshotId;
  try {
    state.library = await api.library.load(snapshotId);
    if (!state.library.books.some((b) => b.id === state.selectedBookId)) state.selectedBookId = null;
    state.words = null;
    await refreshSnapshots();
    renderLibrary();
    renderBuilder();
  } finally {
    state.loadingSnapshotId = null;
  }
}

function renderLibrary() {
  const lib = state.library;
  $("#libraryEmpty").hidden = Boolean(lib);
  $("#libraryBody").hidden = !lib;
  if (!lib) {
    renderBuilder();
    return;
  }
  const { snapshot, summary } = lib;
  $("#libEyebrow").textContent = snapshot.method === "File" ? "Opened file" : `Imported ${timeAgo(snapshot.importedAt)} · ${snapshot.method}`;
  $("#libTitle").textContent = snapshot.deviceName || "vocab.db";
  $("#libMeta").textContent = `${plural(summary.books, "book")} · ${plural(summary.words, "word")} · ${plural(summary.lookups, "lookup")}${
    summary.lastTs ? ` · last lookup ${fmtDate(summary.lastTs)}` : ""
  }`;
  renderBooks();
}

function visibleBooks() {
  const q = normalize($("#bookSearch").value.trim());
  const showEmpty = $("#showEmpty").checked;
  const sort = $("#bookSort").value;
  const books = state.library.books.filter(
    (b) => (showEmpty || b.lookups > 0) && (!q || normalize(`${b.title} ${b.authors}`).includes(q))
  );
  const byTitle = (a, b) => String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" });
  if (sort === "title") books.sort(byTitle);
  else if (sort === "lookups") books.sort((a, b) => b.lookups - a.lookups || byTitle(a, b));
  else books.sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0) || byTitle(a, b));
  return books;
}

function renderBooks() {
  const books = visibleBooks();
  const list = $("#bookList");
  if (!books.length) {
    list.innerHTML = `<div class="empty-small">${state.library.books.length ? "No books match." : "This vocab.db has no books yet."}</div>`;
    return;
  }
  list.innerHTML = books
    .map(
      (b) => `<button class="book ${b.id === state.selectedBookId ? "selected" : ""} ${b.lookups ? "" : "empty"}" data-book="${esc(b.id)}" role="option" aria-selected="${b.id === state.selectedBookId}">
        <div class="cover" style="--hue:${hue(b.title)}">${esc(initials(b.title))}</div>
        <div class="book-main">
          <div class="book-title">${esc(b.title || "(untitled)")}</div>
          <div class="book-sub">${esc(b.authors || "Unknown author")}</div>
          <div class="book-tags">
            ${b.lang ? `<span class="tag">${esc(b.lang)}</span>` : ""}
            ${b.last_ts ? `<span class="tag">last read ${esc(timeAgo(b.last_ts))}</span>` : ""}
            ${b.exported ? `<span class="tag ok">${plural(b.exported, "card")} exported</span>` : ""}
          </div>
        </div>
        <div class="book-stats">
          <span class="stat"><span class="num">${fmtInt(b.unique_words)}</span><span class="lbl">words</span></span>
          <span class="stat"><span class="num">${fmtInt(b.lookups)}</span><span class="lbl">lookups</span></span>
        </div>
      </button>`
    )
    .join("");
}

$("#bookList").addEventListener("click", (e) => {
  const id = e.target.closest("[data-book]")?.dataset.book;
  if (id) selectBook(id);
});
$("#bookSearch").addEventListener("input", debounce(renderBooks, 80));
$("#bookSort").addEventListener("change", renderBooks);
$("#showEmpty").addEventListener("change", renderBooks);

// ── builder ─────────────────────────────────────────────────────────────────
function defaultDeckName(b) {
  // Same default as the web app, so decks keep matching names (and note GUIDs).
  return `${b.title || "(untitled)"}${b.authors ? ` — ${b.authors}` : ""}${b.lang ? ` [${b.lang}]` : ""}`;
}

function selectBook(id) {
  const changed = id !== state.selectedBookId;
  state.selectedBookId = id;
  if (changed) {
    state.words = null;
    state.apkg = null;
    const b = selectedBook();
    $("#deckName").value = state.settings.deckNames?.[id] || defaultDeckName(b);
  }
  renderBooks();
  renderBuilder();
}

function applyDefaults() {
  const d = state.settings.defaults || {};
  $(`input[name="mode"][value="${d.perWord ? "word" : "lookup"}"]`).checked = true;
  $("#optScrape").checked = d.scrape !== false;
  $("#optSmart").checked = d.includeSmartVocab !== false;
  $("#optConc").value = d.concurrency || 1;
  $("#optSkipExported").checked = d.skipExported !== false;
  $("#optLlm").checked = Boolean(d.llmModel) && state.models.some((m) => m.id === d.llmModel);
}

function renderLlmOptions() {
  const sel = $("#optLlmModel");
  const has = state.models.length > 0;
  sel.innerHTML = state.models.map((m) => `<option value="${esc(m.id)}">${esc(m.model)} · ${esc(m.provider)}</option>`).join("");
  const preferred = state.settings.defaults?.llmModel;
  if (preferred && state.models.some((m) => m.id === preferred)) sel.value = preferred;
  $("#optLlm").disabled = !has;
  $("#optLlm").closest(".check").classList.toggle("disabled", !has);
  if (!has) $("#optLlm").checked = false;
  $("#llmHint").textContent = has ? "" : "Add an OpenAI key or an Ollama URL in Settings to enable.";
  syncOptionVisibility();
}

function syncOptionVisibility() {
  $("#scrapeOptions").hidden = !$("#optScrape").checked;
  $("#llmOptions").hidden = !$("#optLlm").checked;
}

function readOptions() {
  return {
    snapshotId: state.library.snapshot.id,
    bookId: state.selectedBookId,
    deckName: $("#deckName").value.trim(),
    perWord: $('input[name="mode"]:checked').value === "word",
    scrape: $("#optScrape").checked,
    includeSmartVocab: $("#optSmart").checked,
    concurrency: Math.max(1, Math.min(8, Number($("#optConc").value) || 1)),
    llmModel: $("#optLlm").checked ? $("#optLlmModel").value : "",
    skipExported: $("#optSkipExported").checked,
    apkgToken: state.apkg?.token || null
  };
}

function runningJobFor(bookId) {
  return state.jobs.find((j) => j.bookId === bookId && j.status === "running");
}

function renderBuilder() {
  const b = selectedBook();
  $("#builderEmpty").hidden = Boolean(b);
  $("#builderBody").hidden = !b;
  if (!b) return;
  $("#bTitle").textContent = b.title || "(untitled)";
  $("#bAuthor").textContent = b.authors || "";
  $("#bStats").innerHTML = [
    `<span class="stat-chip"><b>${fmtInt(b.unique_words)}</b> words</span>`,
    `<span class="stat-chip"><b>${fmtInt(b.lookups)}</b> lookups</span>`,
    b.first_ts ? `<span class="stat-chip">${esc(fmtDate(b.first_ts))} – ${esc(fmtDate(b.last_ts))}</span>` : ""
  ].join("");
  $("#apkgInfo").textContent = state.apkg ? `${state.apkg.name}: ${plural(state.apkg.count, "card")}` : "";
  $("#apkgClear").hidden = !state.apkg;
  for (const btn of $$(".seg-btn")) btn.classList.toggle("active", btn.dataset.pane === state.pane);
  $("#pane-options").hidden = state.pane !== "options";
  $("#pane-words").hidden = state.pane !== "words";
  if (state.pane === "words") loadWords();
  renderActiveJob();
  updatePreview();
}

const updatePreview = debounce(async () => {
  const b = selectedBook();
  if (!b || !state.library) return;
  const opts = readOptions();
  try {
    const s = await api.library.preview(opts);
    $("#prevExported").textContent = s.previouslyExported ? `(${plural(s.previouslyExported, "card")} so far)` : "";
    $("#buildSummary").innerHTML = `
      <div><span class="num">${fmtInt(s.entries)}</span><span class="lbl">${opts.perWord ? "words" : "lookups"}</span></div>
      <div><span class="num">${fmtInt(s.overlap)}</span><span class="lbl">already exported</span></div>
      <div class="new"><span class="num">${fmtInt(s.added)}</span><span class="lbl">new cards</span></div>`;
    const running = runningJobFor(b.id);
    $("#buildBtn").disabled = Boolean(running) || s.added === 0;
    $("#buildBtn").textContent = running ? "Building…" : s.added ? `Build deck · ${plural(s.added, "card")}` : "Nothing new to build";
  } catch (e) {
    $("#buildSummary").textContent = e.message;
  }
}, 120);

for (const el of ["#optScrape", "#optSmart", "#optLlm", "#optSkipExported", "#optConc", "#optLlmModel"]) {
  $(el).addEventListener("change", () => {
    syncOptionVisibility();
    updatePreview();
  });
}
for (const r of $$('input[name="mode"]')) {
  r.addEventListener("change", () => {
    state.words = null;
    if (state.pane === "words") loadWords();
    updatePreview();
  });
}
for (const btn of $$(".seg-btn")) {
  btn.addEventListener("click", () => {
    state.pane = btn.dataset.pane;
    renderBuilder();
  });
}

async function loadWords() {
  const b = selectedBook();
  if (!b) return;
  const perWord = $('input[name="mode"]:checked').value === "word";
  const key = `${state.library.snapshot.id}|${b.id}|${perWord}`;
  if (state.words?.key === key) return renderWords();
  $("#wordList").innerHTML = `<div class="empty-small">Loading…</div>`;
  try {
    const rows = await api.library.words({ snapshotId: state.library.snapshot.id, bookId: b.id, perWord });
    state.words = { key, rows };
    renderWords();
  } catch (e) {
    $("#wordList").innerHTML = `<div class="empty-small">${esc(e.message)}</div>`;
  }
}

function highlight(sentence, word) {
  if (!sentence) return "";
  const m = word ? new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(sentence) : null;
  if (!m) return esc(sentence);
  return `${esc(sentence.slice(0, m.index))}<mark>${esc(m[0])}</mark>${esc(sentence.slice(m.index + m[0].length))}`;
}

function renderWords() {
  const rows = state.words?.rows || [];
  if (!rows.length) {
    $("#wordList").innerHTML = `<div class="empty-small">No words for this book.</div>`;
    return;
  }
  $("#wordList").innerHTML = rows
    .map(
      (r) => `<div class="word ${r.known ? "known" : ""}">
        <div class="word-head"><b>${esc(r.word)}</b>${r.stem && r.stem !== r.word ? `<span class="muted small">${esc(r.stem)}</span>` : ""}${
          r.known ? `<span class="tag ok">exported</span>` : ""
        }<span class="date">${esc(fmtDate(r.ts))}</span></div>
        ${r.sentence ? `<p>${highlight(r.sentence, r.word)}</p>` : ""}
      </div>`
    )
    .join("");
}

$("#apkgBtn").addEventListener("click", async () => {
  try {
    const res = await api.apkg.openDialog();
    if (res) setApkg(res);
  } catch (e) {
    showError(e);
  }
});
$("#apkgClear").addEventListener("click", () => {
  state.apkg = null;
  renderBuilder();
});

function setApkg(res) {
  state.apkg = res;
  renderBuilder();
  toast(`${res.name}: ${plural(res.count, "Kindle card")} found; those will be skipped.`, { kind: "ok" });
}

$("#buildBtn").addEventListener("click", async () => {
  if (!selectedBook()) return;
  const opts = readOptions();
  if (!opts.deckName) {
    toast("Please enter a deck name.", { kind: "err" });
    $("#deckName").focus();
    return;
  }
  $("#buildBtn").disabled = true;
  try {
    const job = await api.jobs.start(opts);
    state.sessionJobs.add(job.jobId);
    upsertJob(job);
    $("#activeJob").scrollIntoView({ behavior: "smooth", block: "nearest" });
    state.settings.deckNames = { ...state.settings.deckNames, [opts.bookId]: opts.deckName };
    state.settings.defaults = { ...state.settings.defaults, perWord: opts.perWord, scrape: opts.scrape, includeSmartVocab: opts.includeSmartVocab, concurrency: opts.concurrency, skipExported: opts.skipExported, llmModel: opts.llmModel };
  } catch (e) {
    showError(e);
  } finally {
    updatePreview();
  }
});

// ── jobs ────────────────────────────────────────────────────────────────────
function upsertJob(job) {
  const i = state.jobs.findIndex((j) => j.jobId === job.jobId);
  const prev = i >= 0 ? state.jobs[i] : null;
  if (i >= 0) state.jobs[i] = { ...state.jobs[i], ...job };
  else state.jobs.unshift(job);
  if (prev?.status === "running" && job.status !== "running" && state.sessionJobs.has(job.jobId)) notifyFinished(job);
  renderJobs();
  renderActiveJob();
  if (job.bookId === state.selectedBookId) updatePreview();
}

function notifyFinished(job) {
  if (job.status === "done") {
    toast(`“${job.deckName}” is ready: ${plural(job.newCards, "card")}.`, {
      kind: "ok",
      actions: [
        { label: "Open in Anki", run: () => openJob(job.jobId, "apkg") },
        { label: "Show in folder", run: () => openJob(job.jobId, "folder") }
      ],
      timeout: 12000
    });
    // Exported counts changed; refresh the book badges.
    if (state.library) api.library.load(state.library.snapshot.id).then((lib) => ((state.library = lib), renderBooks())).catch(() => {});
  } else if (job.status === "error") {
    toast(`Building “${job.deckName}” failed.`, { kind: "err", hint: job.error });
  }
}

const openJob = (jobId, what) => api.jobs.open(jobId, what).catch(showError);

function progressNumbers(job) {
  const total = job.total || 0;
  const done = job.done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const elapsed = (job.endedAt || Date.now()) - job.startedAt;
  const speed = done && elapsed ? done / (elapsed / 1000) : 0;
  const eta = speed > 0 && total ? ((total - done) / speed) * 1000 : null;
  return { total, done, pct, elapsed, eta };
}

function jobOptionsText(job) {
  return [
    job.perWord ? "per word" : "per lookup",
    job.scrape ? `Cambridge${job.includeSmartVocab ? " + SMART" : ""}` : "no dictionary",
    job.llmModel ? job.llmModel.replace(/^[^:]+:/, "") : null,
    job.skippedKnown ? `${fmtInt(job.skippedKnown)} known skipped` : null
  ]
    .filter(Boolean)
    .join(" · ");
}

function jobCard(job, { withLog = false } = {}) {
  const p = progressNumbers(job);
  const status = { running: "Building", done: "Ready", error: "Failed", cancelled: "Cancelled" }[job.status] || job.status;
  const logEntries = state.openLogs.get(job.jobId);
  return `<div class="job-card ${esc(job.status)}" data-job="${esc(job.jobId)}">
    <div class="job-top">
      <div style="min-width:0">
        <div class="job-title">${esc(job.deckName)}</div>
        <div class="job-sub">${esc(job.bookTitle)}</div>
      </div>
      <span class="job-status ${esc(job.status)}">${esc(status)}</span>
    </div>
    ${
      job.status === "running"
        ? `<div class="progress"><div data-progress-bar style="width:${p.pct}%"></div></div>
           <div class="job-progress-text" data-progress-text>${progressText(job)}</div>`
        : `<div class="job-sub">${
            job.status === "done" ? `${plural(job.newCards, "card")} · ` : ""
          }${esc(jobOptionsText(job))} · ${esc(timeAgo(job.startedAt))}${job.endedAt ? ` · took ${fmtDuration(job.endedAt - job.startedAt)}` : ""}</div>`
    }
    ${job.status === "error" && job.error ? `<div class="job-error">${esc(job.error)}</div>` : ""}
    <div class="job-actions">
      ${job.status === "running" ? `<button class="btn btn-danger btn-sm" data-job-action="cancel">Cancel</button>` : ""}
      ${
        job.status === "done"
          ? `<button class="btn btn-primary btn-sm" data-job-action="apkg">Open in Anki</button>
             <button class="btn btn-ghost btn-sm" data-job-action="folder">Show in folder</button>
             <button class="btn btn-ghost btn-sm" data-job-action="markdown">Markdown</button>`
          : ""
      }
      ${withLog ? `<button class="btn btn-ghost btn-sm" data-job-action="log">${logEntries ? "Hide log" : "Log"}</button>` : ""}
      ${withLog && job.status !== "running" ? `<button class="link-btn" data-job-action="remove" style="margin-left:auto">Remove from list</button>` : ""}
    </div>
    ${logEntries ? `<pre class="log" data-log>${logEntries.map(logLine).join("")}</pre>` : ""}
  </div>`;
}

function progressText(job) {
  const p = progressNumbers(job);
  const eta = p.eta == null ? "starting…" : p.eta < 1500 ? "almost done" : `about ${fmtDuration(p.eta)} left`;
  return `<span>${fmtInt(p.done)} / ${fmtInt(p.total)} (${p.pct}%)</span><span>${eta}</span>`;
}

function logLine(e) {
  const t = new Date(e.ts).toLocaleTimeString();
  const scope = e.scope ? `[${e.scope}] ` : "";
  const word = e.word ? `${e.word}: ` : "";
  return `<span class="${esc(e.level)}">${esc(`${t}  ${scope}${word}${e.message}`)}</span>\n`;
}

function renderJobs() {
  const count = state.jobs.filter((j) => j.status === "running").length;
  $("#jobsCount").hidden = count === 0;
  $("#jobsCount").textContent = count;
  $("#jobsEmpty").hidden = state.jobs.length > 0;
  $("#jobsList").innerHTML = state.jobs.map((j) => jobCard(j, { withLog: true })).join("");
}

function renderActiveJob() {
  const b = selectedBook();
  const job = b && state.jobs.find((j) => j.bookId === b.id && state.sessionJobs.has(j.jobId));
  const el = $("#activeJob");
  el.hidden = !job;
  if (job) el.outerHTML = jobCard(job).replace('<div class="job-card', '<div id="activeJob" class="job-card');
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-job-action]");
  if (!btn) return;
  const jobId = btn.closest("[data-job]").dataset.job;
  const action = btn.dataset.jobAction;
  try {
    if (action === "cancel") await api.jobs.cancel(jobId);
    else if (action === "remove") {
      state.jobs = await api.jobs.remove(jobId);
      state.openLogs.delete(jobId);
      renderJobs();
      renderActiveJob();
    } else if (action === "log") {
      if (state.openLogs.has(jobId)) state.openLogs.delete(jobId);
      else state.openLogs.set(jobId, await api.jobs.logs(jobId));
      renderJobs();
    } else await openJob(jobId, action);
  } catch (err) {
    showError(err);
  }
});

// Running cards tick every second so the time estimate stays fresh.
setInterval(() => {
  for (const job of state.jobs.filter((j) => j.status === "running")) updateProgressDom(job);
}, 1000);

function updateProgressDom(job) {
  for (const card of $$(`[data-job="${CSS.escape(job.jobId)}"]`)) {
    const bar = $("[data-progress-bar]", card);
    const text = $("[data-progress-text]", card);
    if (bar) bar.style.width = `${progressNumbers(job).pct}%`;
    if (text) text.innerHTML = progressText(job);
  }
}

// ── settings ────────────────────────────────────────────────────────────────
function renderSettings() {
  const s = state.settings;
  $("#outputDir").textContent = s.outputDir;
  $("#setAutoImport").checked = s.autoImport !== false;
  $("#setReleaseCamera").checked = s.releaseCameraDaemon !== false;
  $("#openaiKey").value = "";
  $("#openaiKey").placeholder = s.llm.openai.hasApiKey ? "Saved; type a new key to replace it" : "sk-…";
  $("#removeKey").hidden = !s.llm.openai.hasApiKey;
  $("#openaiModels").value = s.llm.openai.models || "";
  $("#ollamaUrl").value = s.llm.ollama.url || "";
  $("#ollamaModels").value = s.llm.ollama.models || "";
}

async function saveSettings(patch, note) {
  try {
    state.settings = await api.settings.save(patch);
    state.models = await api.llm.models();
    renderSettings();
    renderLlmOptions();
    if (note) {
      $("#llmSaved").textContent = note;
      setTimeout(() => ($("#llmSaved").textContent = ""), 2500);
    }
  } catch (e) {
    showError(e);
  }
}

$("#chooseOutput").addEventListener("click", async () => {
  try {
    state.settings = await api.settings.chooseOutputDir();
    renderSettings();
  } catch (e) {
    showError(e);
  }
});
$("#setAutoImport").addEventListener("change", (e) => saveSettings({ autoImport: e.target.checked }));
$("#setReleaseCamera").addEventListener("change", (e) => saveSettings({ releaseCameraDaemon: e.target.checked }));
$("#saveLlm").addEventListener("click", () => {
  const key = $("#openaiKey").value.trim();
  saveSettings(
    {
      llm: {
        openai: { models: $("#openaiModels").value, ...(key ? { apiKey: key } : {}) },
        ollama: { url: $("#ollamaUrl").value.trim(), models: $("#ollamaModels").value }
      }
    },
    "Saved"
  );
});
$("#removeKey").addEventListener("click", () => saveSettings({ llm: { openai: { apiKey: "" } } }, "Key removed"));
$("#openData").addEventListener("click", () => api.openDataFolder().catch(showError));
$("#copyLog").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#deviceLog").textContent);
  toast("Diagnostics copied.", { kind: "ok", timeout: 2500 });
});

async function refreshDeviceLog() {
  const lines = await api.devices.log().catch(() => []);
  const el = $("#deviceLog");
  el.textContent = lines.length ? lines.join("\n") : "Nothing yet.";
  el.scrollTop = el.scrollHeight;
}

// ── drag & drop ─────────────────────────────────────────────────────────────
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("#dropOverlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("#dropOverlay").hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#dropOverlay").hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    if (/\.apkg$/i.test(file.name)) {
      if (!selectedBook()) {
        toast("Select a book first, then drop the .apkg to skip the words already in it.");
        return;
      }
      setApkg(await api.apkg.openFile(file));
    } else {
      const res = await api.vocab.openFile(file);
      await loadLibrary(res.snapshot.id);
      toast(res.unchanged ? "This vocab.db was imported before." : `Imported ${file.name}.`, { kind: "ok" });
    }
  } catch (err) {
    showError(err);
  }
});

// ── live events ─────────────────────────────────────────────────────────────
api.devices.onState((s) => {
  state.devices = s;
  renderDevices();
});
api.devices.onLog((line) => {
  const el = $("#deviceLog");
  if (!$("#view-settings").classList.contains("active")) return;
  el.textContent = el.textContent === "Nothing yet." ? line : `${el.textContent}\n${line}`;
  el.scrollTop = el.scrollHeight;
});
api.vocab.onImported(async ({ snapshot, unchanged, auto }) => {
  if (state.library?.snapshot.id === snapshot.id) {
    await refreshSnapshots();
    return;
  }
  await loadLibrary(snapshot.id).catch(showError);
  if (auto) {
    toast(
      unchanged
        ? `${snapshot.deviceName}: vocabulary is up to date.`
        : `Imported from ${snapshot.deviceName}: ${plural(snapshot.summary?.lookups ?? 0, "lookup")} in ${plural(snapshot.summary?.books ?? 0, "book")}.`,
      { kind: "ok" }
    );
  }
});
api.jobs.onUpdate(upsertJob);
api.jobs.onProgress(({ jobId, done, total }) => {
  const job = state.jobs.find((j) => j.jobId === jobId);
  if (!job) return;
  Object.assign(job, { done, total });
  updateProgressDom(job);
});
api.jobs.onLog(({ jobId, entry }) => {
  const entries = state.openLogs.get(jobId);
  if (!entries) return;
  entries.push(entry);
  const pre = $(`#jobsList [data-job="${CSS.escape(jobId)}"] [data-log]`);
  if (pre) {
    pre.insertAdjacentHTML("beforeend", logLine(entry));
    pre.scrollTop = pre.scrollHeight;
  }
});

// ── init ────────────────────────────────────────────────────────────────────
async function init() {
  state.info = await api.appInfo();
  document.body.classList.add(`platform-${state.info.platform}`);
  $("#version").textContent = `v${state.info.version}`;
  state.settings = await api.settings.get();
  state.models = await api.llm.models();
  renderSettings();
  applyDefaults();
  renderLlmOptions();

  state.devices = await api.devices.get();
  renderDevices();
  state.jobs = await api.jobs.list();
  renderJobs();

  await refreshSnapshots();
  const last = state.snapshots.find((s) => s.id === state.settings.lastSnapshotId) || state.snapshots[0];
  if (last) await loadLibrary(last.id).catch(showError);
  else renderLibrary();
}

init().catch(showError);
