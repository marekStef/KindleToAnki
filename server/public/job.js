(function () {
  const id = window.location.pathname.split("/").pop();
  const pw = (localStorage.getItem("kvta_pw") || "").trim();

  

  const el = (id)=>document.getElementById(id);

  const logEl = el("log");
  function addLog(entry) {
    if (!logEl) return;
    const ts = entry?.ts ? new Date(entry.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const lvl = (entry?.level || "info").toUpperCase().padEnd(5);
    const scope = entry?.scope ? `[${entry.scope}]` : "";
    const word = entry?.word ? ` ${entry.word}` : "";
    const model = entry?.model ? ` (${entry.model})` : "";
    const msg = entry?.message || String(entry || "");
    const line = document.createElement("div");
    line.textContent = `${ts}  ${lvl}  ${scope}${word}${model}: ${msg}`;
    line.style.whiteSpace = "pre-wrap";
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  el("cancelBtn").addEventListener("click", async () => {
  if (!confirm("Really stop this job?")) return;
  const r = await fetch(`/api/job/${id}/cancel`, {
    method: "POST",
    headers: { "x-app-password": pw }
  }).then(r => r.json());
  if (!r.ok) alert(r.error || "Failed");
});


  function fmtDate(ms){ return ms ? new Date(ms).toLocaleString() : ""; }
  function fmtEta(ms){
    if (!ms && ms !== 0) return "–";
    const s = Math.max(0, Math.round(ms/1000));
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    return `${h}h ${m}m ${sec}s`;
  }

  async function loadHeader(){
    const res = await fetch(`/api/job/${id}?password=${encodeURIComponent(pw)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to load job");
    const j = data.job;
    el("h").textContent = j.bookTitle || "(book)";
    el("deck").textContent = j.deckName || "";
    el("status").textContent = j.status;
    el("started").textContent = fmtDate(j.startedAt);
    el("ended").textContent = fmtDate(j.endedAt);
    const pct = j.total ? Math.round((j.done||0)/j.total*100) : 0;
    el("prog").textContent = `${j.done||0} / ${j.total||0} (${pct}%)`;
    el("bar").firstElementChild.style.width = pct + "%";
    const dl = el("dl");
    const dlMd = el("dlMd");
    if (j.downloadUrl) {
      dl.style.display = "";
      dl.href = `${j.downloadUrl}?password=${encodeURIComponent(pw)}`;
    }
    if (j.markdownUrl) {
      dlMd.style.display = "";
      dlMd.href = `${j.markdownUrl}?password=${encodeURIComponent(pw)}`;
    }
  }

  // initial header
  loadHeader().catch(e => { el("status").textContent = "error"; console.error(e); });

    // preload persisted logs so they survive refreshes
  (async function preloadLogs(){
    try {
      const r = await fetch(`/api/job/${id}/logs?password=${encodeURIComponent(pw)}&limit=10000`);
      const d = await r.json();
      if (d.ok && Array.isArray(d.logs)) d.logs.forEach(addLog);
    } catch (e) {
      // non-fatal; keep streaming
      console.warn("logs preload failed:", e);
    }
  })();

  // live SSE
  const ev = new EventSource(`/api/progress/${id}?password=${encodeURIComponent(pw)}`);
  ev.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    el("status").textContent = "running";
    el("prog").textContent = `${p.done} / ${p.total} (${pct}%)`;
    el("bar").firstElementChild.style.width = pct + "%";
    el("speed").textContent = (p.speed || 0).toFixed(2);
    el("eta").textContent = fmtEta(p.etaMs);
  });

  // stream log lines
  ev.addEventListener("log", (e) => {
    try { addLog(JSON.parse(e.data)); }
    catch { addLog({ level:"error", message:String(e.data) }); }
  });

  ev.addEventListener("done", (e) => {
    const { downloadId, fileName, mdDownloadId, mdFileName } = JSON.parse(e.data);
    el("status").textContent = "done";
    el("bar").firstElementChild.style.width = "100%";
    el("prog").textContent = `100%`;
    const a = el("dl");
    a.style.display = "";
    a.href = `/api/download/${downloadId}?password=${encodeURIComponent(pw)}`;
    a.download = fileName || "deck.apkg";
    const b = el("dlMd");
    if (mdDownloadId) {
      b.style.display = "";
      b.href = `/api/download/${mdDownloadId}?password=${encodeURIComponent(pw)}`;
      b.download = mdFileName || "deck.md";
    }
    loadHeader().catch(()=>{});
    ev.close();
  });

  ev.addEventListener("error", (e) => {
    if (ev.readyState !== EventSource.CLOSED || el("status").textContent !== "done") {
      el("status").textContent = "error";
    }
    // Do not add a log here; the server already emitted a persisted "log" line
    // alongside this terminal "error" event.
    ev.close();
  });
  ev.addEventListener("cancelled", () => {
  el("status").textContent = "cancelled";
  ev.close();

  function hideCancel(){ el("cancelBtn").style.display="none"; }
ev.addEventListener("done", hideCancel);
ev.addEventListener("cancelled", hideCancel);
ev.addEventListener("error", hideCancel);

});

})();
