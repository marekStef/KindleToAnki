(function () {
  const id = window.location.pathname.split("/").pop();
  const pw = (localStorage.getItem("kvta_pw") || "").trim();

  const el = (id)=>document.getElementById(id);

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
    if (j.downloadUrl) {
      dl.style.display = "";
      dl.href = `${j.downloadUrl}?password=${encodeURIComponent(pw)}`;
    }
  }

  // initial header
  loadHeader().catch(e => { el("status").textContent = "error"; console.error(e); });

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
  ev.addEventListener("done", (e) => {
    const { downloadId, fileName } = JSON.parse(e.data);
    el("status").textContent = "done";
    el("bar").firstElementChild.style.width = "100%";
    el("prog").textContent = `100%`;
    const a = el("dl");
    a.style.display = "";
    a.href = `/api/download/${downloadId}?password=${encodeURIComponent(pw)}`;
    a.download = fileName || "deck.apkg";
    loadHeader().catch(()=>{});
    ev.close();
  });
  ev.addEventListener("error", (e) => {
    el("status").textContent = "error";
    ev.close();
  });
})();
