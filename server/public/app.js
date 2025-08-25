const $ = (id) => document.getElementById(id);

// ── global state ─────────────────────────────────────────────────────────────
let token = null;
let building = false;
let models = [];       // list returned by /api/llm-models
let llmAvailable = false;    // ⇢ true if server exposes ≥1 model

// ── tiny helpers ─────────────────────────────────────────────────────────────
function msg(el, text = "", isErr = false) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", isErr);
}
function savePw(pw) { try { localStorage.setItem("kvta_pw", pw); } catch { } }
function loadPw() { try { return localStorage.getItem("kvta_pw") || ""; } catch { return ""; } }

// ── LLM controls: show/hide dropdown when checkbox toggles ───────────────────
$("includeLlm").addEventListener("change", (e) => {
  $("llmBox").style.display = e.target.checked ? "" : "none";
});

(async function showVersion() {
  try {
    const r = await fetch("/api/meta");
    const d = await r.json();
    if (d.ok && d.version) document.getElementById("ver").textContent = d.version;
  } catch { /* swallow if offline */ }
})();

(async function initUi() {
  // 1) pre-fill password if stored
  $("pw").value = loadPw();

  // 2) fetch available LLM models (empty list ⇒ feature disabled)
  try {
    const res = await fetch("/api/llm-models");
    const d = await res.json();
    if (d.ok) models = d.models || [];
  } catch { /* network error → treat as no LLM */ }

  llmAvailable = models.length > 0;

  const llmBox = $("llmBox");           // wrapper div with checkbox + select
  const sel = $("llmModel");

  if (!llmAvailable) {
    llmBox.style.display = "none";      // hide entire control group
  } else {
    sel.innerHTML = models
      .map((m) => `<option value="${m.id}" title="${m.quality || ''}">${m.name || m.id}</option>`)
      .join("");

    /* ✱ update the little info line whenever the selection changes */
    const info = $("llmInfo");
    const showInfo = () => {
      const m = models.find(x => x.id === sel.value) || {};
      info.textContent = [m.quality, m.notes].filter(Boolean).join(" · ");
    };
    sel.addEventListener("change", showInfo);
    showInfo();               // run once for the default option
  }
})();

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║                          STEP 1 – file upload                           ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
$("uploadBtn").addEventListener("click", async () => {
  const pw = $("pw").value.trim();
  const file = $("file").files[0];

  if (!pw || !file) {
    msg($("s1msg"), "Password and file are required.", true);
    return;
  }
  savePw(pw);

  const fd = new FormData();
  fd.append("db", file);

  $("uploadBtn").disabled = true;
  msg($("s1msg"), "Uploading & parsing…");

  try {
    const r = await fetch("/api/upload", {
      method: "POST",
      headers: { "x-app-password": pw },
      body: fd
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Upload failed");

    token = d.token;

    /* populate book dropdown ------------------------------------------------ */
    const sel = $("book");
    sel.innerHTML = "";
    d.books.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      const title = b.title || "(untitled)";
      const author = b.authors ? ` — ${b.authors}` : "";
      const lang = b.lang ? ` [${b.lang}]` : "";
      opt.textContent = `${title}${author}${lang}`;
      opt.dataset.stats = `${b.unique_words} words, ${b.lookups} lookups`;
      sel.appendChild(opt);
    });

    if (sel.options.length) {
      $("bookStats").textContent = sel.options[0].dataset.stats;
      $("deck").value = (sel.options[0].textContent || "Kindle Vocab").trim();
    }

    sel.addEventListener("change", () => {
      const o = sel.options[sel.selectedIndex];
      $("bookStats").textContent = o.dataset.stats || "";
      $("deck").value = (o.textContent || "Kindle Vocab").trim();  // always update
    });

    $("step2").classList.remove("hidden");
    msg($("s1msg"), "Upload OK.");
  } catch (e) {
    console.error(e);
    msg($("s1msg"), e.message || "Upload failed", true);
  } finally {
    $("uploadBtn").disabled = false;
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║                     STEP 2 – build / convert click                      ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
$("buildBtn").addEventListener("click", async () => {
  if (building) return;                 // double-click guard
  const pw = $("pw").value.trim();
  savePw(pw);

  const payload = {
    token,
    bookId: $("book").value,
    deckName: $("deck").value.trim(),
    perWord: $("perWord").checked,
    noScrape: false,
    includeSmartVocab: $("includeSmart").checked,
    concurrency: Number($("conc").value) || 1,
    includeLlm: llmAvailable ? $("includeLlm").checked : false,
    llmModel: llmAvailable ? $("llmModel").value : undefined
  };

  if (!token) { msg($("s2msg"), "No upload token. Upload first.", true); return; }
  if (!payload.deckName) { msg($("s2msg"), "Deck name is required.", true); return; }

  $("buildBtn").disabled = true;
  building = true;
  msg($("s2msg"), "Starting build…");

  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-password": pw },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Conversion failed");

    // Jump straight to job detail screen
    window.location.href = data.jobUrl;
  } catch (e) {
    console.error(e);
    building = false;
    msg($("s2msg"), e.message || "Conversion failed", true);
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║                    Homepage – past jobs table (optional)                ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
(async function loadJobsList() {
  const pw = ($("pw").value.trim()) || loadPw();
  try {
    const res = await fetch("/api/jobs", { headers: { "x-app-password": pw } });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || "Failed to load jobs");

    const tbody = $("jobsTable")?.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    d.jobs.forEach((j) => {
      const tr = document.createElement("tr");
      const started = j.startedAt ? new Date(j.startedAt).toLocaleString() : "";
      const ended = j.endedAt ? new Date(j.endedAt).toLocaleString() : "";
      const pct = j.total ? Math.round(((j.done || 0) / j.total) * 100) : (j.done || 0);
      const dlDeck = j.downloadUrl
        ? `<a href="${j.downloadUrl}?password=${encodeURIComponent(pw)}">deck</a>` : "";
      const dlMd = j.markdownUrl
        ? `<a href="${j.markdownUrl}?password=${encodeURIComponent(pw)}">markdown</a>` : "";
      const dlCell = [dlDeck, dlMd].filter(Boolean).join(" | ");

      tr.innerHTML = `
        <td>${j.bookTitle || ""}</td>
        <td>${j.deckName || ""}</td>
        <td>${j.status}</td>
        <td>${j.includeLlm ? "yes" : "no"}</td>
        <td>${j.llmModel || "–"}</td>
        <td>${started}</td>
        <td>${ended}</td>
        <td>${j.total ? pct + "%" : (j.done || 0)}</td>
        <td><a href="/job/${j.jobId}">open</a></td>
        <td>${dlCell}</td>`;
      // --- NEW delete cell ---------------------------------------------
      const delTd = document.createElement("td");
      if (j.status === "done") {
        const btn = document.createElement("button");
        btn.className = "act-btn";
        btn.textContent = "✕";
        btn.title = "Delete job";
        btn.onclick = async () => {
          if (!confirm("Delete this job? This will remove the .apkg file.")) return;
          btn.disabled = true;
          try {
            const r = await fetch(`/api/job/${j.jobId}/delete`, {
              method: "POST",
              headers: { "x-app-password": pw }
            }).then(r => r.json());
            if (!r.ok) throw new Error(r.error || "Delete failed");
            tr.remove();                       // vanish from the list
          } catch (e) {
            alert(e.message);
            btn.disabled = false;
          }
        };
        delTd.appendChild(btn);
      }
      tr.appendChild(delTd);
      // ------------------------------------------------------------------

      tbody.appendChild(tr);
    });
  } catch (e) {
    msg($("jobsMsg"), e.message, true);
  }
})();

// ── dropzone setup ───────────────────────────────────────────────────────────
function formatBytes(bytes){
  if (!Number.isFinite(bytes)) return "";
  const u = ["B","KB","MB","GB"]; let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length-1){ n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

(function initDropzone(){
  const dz = $("dropzone");
  const fi = $("file");
  const info = $("dropInfo");

  if (!dz || !fi) return;

  const setSelectedFile = (file) => {
    if (!file) return;
    // Only accept .db by name (mimetypes are unreliable for sqlite)
    if (!/\.db$/i.test(file.name)) {
      msg($("s1msg"), "Please select a .db file (Kindle vocab.db).", true);
      return;
    }
    // Put file into the hidden input so existing code keeps working
    const dt = new DataTransfer();
    dt.items.add(file);
    fi.files = dt.files;

    // Nice visual status
    info.innerHTML = `<span class="file-chip"><code>${file.name}</code> ${formatBytes(file.size)}</span>`;
    dz.classList.add("hasfile");
    msg($("s1msg"), "File ready. You can now Upload & List Books.");
  };

  // Clicking the square opens the file picker
  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); }
  });

  // If user chooses via picker
  fi.addEventListener("change", () => {
    if (fi.files && fi.files[0]) setSelectedFile(fi.files[0]);
  });

  // Drag & drop
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["dragenter","dragover"].forEach(ev =>
    dz.addEventListener(ev, (e) => { prevent(e); dz.classList.add("dragover"); })
  );
  ["dragleave","dragend","drop"].forEach(ev =>
    dz.addEventListener(ev, (e) => { prevent(e); dz.classList.remove("dragover"); })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) setSelectedFile(f);
  });
})();
