const $ = (id) => document.getElementById(id);
let token = null;

function msg(el, text, isErr = false) {
  el.textContent = text || "";
  el.classList.toggle("err", !!isErr);
}

$("uploadBtn").addEventListener("click", async () => {
  const pw = $("pw").value.trim();
  const file = $("file").files[0];
  if (!pw || !file) {
    msg($("s1msg"), "Password and file are required.", true);
    return;
  }

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
  const pw = $("pw").value.trim();
  const bookId = $("book").value;
  const deckName = $("deck").value.trim();
  const perWord = $("perWord").checked;
  const noScrape = $("noScrape").checked;
  const concurrency = Number($("conc").value || 1);

  if (!token) {
    msg($("s2msg"), "No upload token. Upload a vocab.db first.", true);
    return;
  }
  if (!deckName) {
    msg($("s2msg"), "Deck name is required.", true);
    return;
  }

  $("buildBtn").disabled = true;
  msg($("s2msg"), "Building deck… this may take a bit.");

  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-password": pw
      },
      body: JSON.stringify({ token, bookId, deckName, perWord, noScrape, concurrency })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Conversion failed");

    const dl = $("dl");
    dl.href = `/api/download/${data.downloadId}?password=${encodeURIComponent(pw)}`;
    dl.download = data.fileName || "deck.apkg";

    $("step3").classList.remove("hidden");
    msg($("s2msg"), "Done.");
  } catch (e) {
    console.error(e);
    msg($("s2msg"), e.message || "Conversion failed", true);
  } finally {
    $("buildBtn").disabled = false;
  }
});