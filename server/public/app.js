const $ = (id) => document.getElementById(id);
let token = null;
let building = false;

function msg(el, text, isErr = false) {
  el.textContent = text || "";
  el.classList.toggle("err", !!isErr);
}

// persist/reuse password locally (so /job/:id can reconnect SSE)
function savePw(pw){ try{ localStorage.setItem("kvta_pw", pw); }catch{} }
function loadPw(){ try{ return localStorage.getItem("kvta_pw") || ""; }catch{ return ""; } }

$("includeLlm").addEventListener("change", e=>{
  $("llmModel").parentElement.style.display = e.target.checked ? "" : "none";
});

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
    const res = await fetch("/api/upload", {
       method: "POST",
       headers: { "x-app-password": pw },
       body: fd
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Upload failed");

    token = data.token;

    // Populate books
    const sel = $("book");
    sel.innerHTML = "";
    data.books.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      const title = b.title || "(untitled)";
      const authors = b.authors ? ` — ${b.authors}` : "";
      const lang = b.lang ? ` [${b.lang}]` : "";
      opt.textContent = `${title}${authors}${lang}`;
      opt.dataset.stats = `${b.unique_words} words, ${b.lookups} lookups`;
      sel.appendChild(opt);
    });

    if (sel.options.length) {
      $("bookStats").textContent = sel.options[0].dataset.stats;
      $("deck").value = (sel.options[0].textContent || "Kindle Vocab").replace(/\s+/g, " ");
    }

    sel.addEventListener("change", () => {
      const s = sel.options[sel.selectedIndex];
      $("bookStats").textContent = s.dataset.stats || "";
      if (!$("deck").value) $("deck").value = (s.textContent || "Kindle Vocab").replace(/\s+/g, " ");
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

$("buildBtn").addEventListener("click", async () => {
  // ‼️ ignore clicks while a build is already running
  if (building) return;
  const pw = $("pw").value.trim();
  savePw(pw);
  const bookId = $("book").value;
  const deckName = $("deck").value.trim();
  const perWord = $("perWord").checked;
  // const noScrape = $("noScrape").checked;
  const noScrape = false;
  const includeSmartVocab = $("includeSmart").checked;
  const concurrency = Number($("conc").value || 1);
  const includeLlm = $("includeLlm").checked;
  const llmModel = $("llmModel").value;

  if (!token) {
    msg($("s2msg"), "No upload token. Upload a vocab.db first.", true);
    return;
  }
  if (!deckName) {
    msg($("s2msg"), "Deck name is required.", true);
    return;
  }

  $("buildBtn").disabled = true;
  building = true;
  msg($("s2msg"), "Starting build…");

  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-password": pw
      },
      body: JSON.stringify({
        token, bookId, deckName, perWord, noScrape, concurrency,
        includeSmartVocab, includeLlm, llmModel
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Conversion failed");

    
    
     // NEW: take user to the dedicated job screen (/job/:id)
     window.location.href = data.jobUrl;


  } catch (e) {
    console.error(e);
    building = false;  
    msg($("s2msg"), e.message || "Conversion failed", true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Past jobs on the homepage
// ─────────────────────────────────────────────────────────────────────────────
(async function loadJobsList(){
  const pwInput = $("pw");
  const pw = (pwInput?.value?.trim()) || loadPw();
  // if (!pw) return; // no password yet
  try {
    const res = await fetch(`/api/jobs`, {
      headers: { "x-app-password": pw }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to load jobs");
    const tbody = $("jobsTable")?.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const j of data.jobs) {
      const tr = document.createElement("tr");
      const started = j.startedAt ? new Date(j.startedAt).toLocaleString() : "";
      const ended   = j.endedAt   ? new Date(j.endedAt).toLocaleString()   : "";
      const pct = j.total ? Math.round((j.done||0)/j.total*100) : (j.done||0);
      const jobLink = `<a href="/job/${j.jobId}">open</a>`;
      const dl = j.downloadUrl ? `<a href="${j.downloadUrl}?password=${encodeURIComponent(pw)}">download</a>` : "";
      tr.innerHTML = `
        <td>${(j.bookTitle||"")}</td>
        <td>${(j.deckName||"")}</td>
        <td>${j.status}</td>
        <td>${j.includeLlm ? "yes" : "no"}</td>
        <td>${j.llmModel||"–"}</td>
        <td>${started}</td>
        <td>${ended}</td>
        <td>${(j.total? pct+"%": (j.done||0))}</td>
        <td>${jobLink}</td>
        <td>${dl}</td>
        <td><button class="act-btn" title="Delete" data-id="${j.jobId}" ${j.status!=="done"?"disabled":""}>🗑</button></td>
        `;
        
      tbody.appendChild(tr);
    }
        // delegated delete handler
    tbody.addEventListener("click", async (ev)=>{
      if(ev.target.matches(".act-btn")){
        const id = ev.target.dataset.id;
        if(!confirm("Move this deck to trash?")) return;
        const r = await fetch(`/api/job/${id}/delete`,{
          method:"POST",
          headers:{ "x-app-password": pw }
        }).then(r=>r.json());
        if(!r.ok){ alert(r.error||"Failed"); return; }
        ev.target.closest("tr").remove();
      }
    });
  } catch (e) {
    const m = $("jobsMsg"); if (m) m.textContent = e.message;
  }
})();