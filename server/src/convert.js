// Core conversion logic adapted from your CLI (kindle_vocabdb_to_anki.mjs)
// Exposed as callable functions for the web server.

import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import AnkiExport from "@steve2955/anki-apkg-export";
import { load as cheerioLoad } from "cheerio";
import { marked } from "marked";
import { spawn } from "node:child_process";

const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "").trim();

// --- NEW: helpers & color constants ---
const escapeRegExp = (s = "") => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findWordFormInSentence(word = "", sentence = "") {
  if (!word || !sentence) return "";
  const re = new RegExp(`\\b(${escapeRegExp(word)})\\b`, "i");
  const m = sentence.match(re);
  return m ? m[0] : "";
}

// Colors for the BACK side (headers/tiles, meanings, examples)
const COLORS = {
  tileBg:      "#0E2A47",
  tileText:    "#E6F1FF",
  tileBorder:  "rgba(255,255,255,0.12)",

  meaningBg:   "#1B3B5F",
  meaningText: "#EAF4FF",
  meaningRing: "rgba(230,241,255,.18)",

  exampleBg:   "#112D3A",
  exampleText: "#CDE9FF",
  exampleRing: "rgba(205,233,255,.16)"
};

const FONT = {
  basePx: 15,      // global base size on both sides (try 14–16)
  headingEm: 1.05, // h1/h2/h3 size on the back
  wordEm: 1.2,     // main word on the front
  listEm: 0.95,    // meanings list size
  smallEm: 0.9     // tiny meta (IDs, etc.)
};



const H = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  "Accept-Language": "en"
};
const BASE = "https://dictionary.cambridge.org/dictionary/english/";

const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
const mdEscape = (s) => (s || "").replace(/([_*`~])/g, "\\$1");
const escapeHtml = (s = "") =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function extractDefBlock($, $block) {
  const level = clean($block.find(".ddef_h .def-info").text());
  const def = clean($block.find(".ddef_h .def.ddef_d.db").text());
  if (!def) return null;
  const examples = [];
  $block.find(".def-body.ddef_b .examp.dexamp").each((_, exWrap) => {
    const $wrap = $(exWrap);
    const lu = clean($wrap.find(".lu.dlu").text());
    const sent = clean($wrap.find(".eg.deg").text());
    if (sent) {
      examples.push(lu ? `**${mdEscape(lu)}** — ${mdEscape(sent)}` : mdEscape(sent));
    }
  });
  return { def, level: level || null, examples };
}

async function fetchHtml(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: H });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function scrapeCambridgeMarkdown(word, { includeSmartVocab = true } = {}) {
  const URL  = BASE + encodeURIComponent(String(word || "").toLowerCase());
  const html = await fetchHtml(URL);
  const $    = cheerioLoad(html);

  /** helper -------------------------------------------------------------- */
  const clean      = (t) => (t || "").replace(/\s+/g, " ").trim();
  const mdEscape   = (s) => (s || "").replace(/([_*`~])/g, "\\$1");
  const absUrl     = (h) => h && h.startsWith("/") ? "https://dictionary.cambridge.org" + h : h;

  function extractDefBlock($block) {
    const level = clean($block.find(".ddef_h .def-info").text());
    const def   = clean($block.find(".ddef_h .def.ddef_d.db").text());
    if (!def) return null;

    const examples = [];
    $block.find(".def-body.ddef_b .examp.dexamp").each((_, exWrap) => {
      const lu   = clean($(exWrap).find(".lu.dlu").text());
      const sent = clean($(exWrap).find(".eg.deg").text());
      if (sent) examples.push(lu ? `**${mdEscape(lu)}** — ${mdEscape(sent)}` : mdEscape(sent));
    });
    return { def, level: level || null, examples };
  }

  /** --------------------------------------------------------------------- */

  const out = [];
  out.push(`# ${mdEscape(word)} — Cambridge Dictionary`);
  out.push(`*Source:* ${URL}`);
  out.push("");

  $(".entry-body__el").each((_, el) => {
    const $el   = $(el);
    const head  = clean($el.find(".pos-header.dpos-h .headword .hw").text()) || word;
    const pos   = clean($el.find(".pos-header.dpos-h .pos.dpos").text());
    if (head || pos) {
      out.push(`## ${mdEscape(head)}${pos ? ` — *${mdEscape(pos)}*` : ""}`);
      out.push("");
    }

    /* 1️⃣  Meanings ------------------------------------------------------ */
    const senses = [];
    $el.find(".def-block.ddef_block")
       .filter((_, b) => $(b).closest(".dphrase-block").length === 0)
       .each((_, b) => {
          const d = extractDefBlock($(b));
          if (d) senses.push(d);
       });

    if (senses.length) {
      // out.push(`### Meanings`);
      senses.forEach((s) => {
        const badge = s.level && s.level.length <= 5 ? ` **[${s.level}]**` : "";
        out.push(`- **${mdEscape(s.def)}**${badge}`);
        s.examples.forEach((e) => out.push(`  - _${mdEscape(e)}_`));
      });
      out.push("");
    }

    /* 2️⃣  Phrasal / Idioms -------------------------------------------- */
    $el.find(".dphrase-block").each((_, b) => {
      const $b     = $(b);
      const title  = clean($b.find(".phrase-head .phrase-title").text());
      const items  = [];
      $b.find(".phrase-body .def-block.ddef_block").each((_, d) => {
        const dblk = extractDefBlock($(d));
        if (dblk) items.push(dblk);
      });
      if (!title || !items.length) return;

      // out.push(`### Phrase ▸ **${mdEscape(title)}**`);
      // items.forEach((it) => {
      //   const badge = it.level && it.level.length <= 5 ? ` **[${it.level}]**` : "";
      //   out.push(`- **${mdEscape(it.def)}**${badge}`);
      //   it.examples.forEach((e) => out.push(`  - _${mdEscape(e)}_`));
      // });
      out.push(
        `<div class="phrasal-vocab">` +
          `<div class="phrasal-title">Phrase ▸ <strong>${escapeHtml(title)}</strong></div>` +
          `<ul>` +
            items.map((it) => {
              const badge = it.level && it.level.length <= 5 ? ` <span class="level">[${escapeHtml(it.level)}]</span>` : "";
              const examples = it.examples.map((e) => `<li class="example">${escapeHtml(e)}</li>`).join("");
              return `<li>${escapeHtml(it.def)}${badge}${examples ? `<ul>${examples}</ul>` : ""}</li>`;
            }).join("") +
          `</ul>` +
        `</div>`,
        ""
      );

      const seeMore = $b.find(".dbtn a.hbtn.hbtn-tab").attr("href");
      if (seeMore) out.push(`> See more: ${absUrl(seeMore)}`);
      out.push("");
    });

    /* 3️⃣  SMART Vocabulary box ------------------------------------------- */
    if (includeSmartVocab) {
    $el.find(".smartt.daccord section").each((_, sec) => {
      const $sec   = $(sec);
      const topic  = clean($sec.find(".daccord_lt a").first().text());
      const links  = [];

      $sec.find(".daccord_lb li a").each((_, a) => {
        const $a   = $(a);
        const text = clean($a.find(".phrase, .base").text() || $a.text());
        const href = absUrl($a.attr("href"));
        if (text && href) links.push({ text, href });
      });

      if (!topic || !links.length) return;
      // Render as a self-contained HTML block so we can style it reliably.
      out.push(
        `<div class="smart-vocab">` +
          `<div class="smart-title">SMART Vocabulary ▸ <em>${escapeHtml(topic)}</em></div>` +
          `<ul>` +
            links.map(({ text, href }) =>
              `<li><a href="${href}">${escapeHtml(text)}</a></li>`
            ).join("") +
          `</ul>` +
        `</div>`,
        ""
      );
    });
  }


    /* 4️⃣  Idioms & phrases  (sidebar + accordion) ---------------------- */
    const idiomLinks = [];
    const seen = new Set();                       // ↓ simple helper
    const add = (text, href) => {
      if (!text || !href) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      idiomLinks.push({ text, href });
    };

    const grabText = ($a) => {
      const phrase = clean($a.find(".phrase").first().text());
      const base   = clean($a.find(".base").first().text());
      return phrase || base || clean($a.text());
    };

    /*  4.a sidebar (“Idioms”) */
    $(".xref.idioms a").each((_, a) => add(grabText($(a)), absUrl($(a).attr("href"))));

    /*  4.b accordion (“Idioms and phrases”) */
    $("header:contains('Idioms and phrases')")
      .next("div")
      .find("a")
      .each((_, a) => add(grabText($(a)), absUrl($(a).attr("href"))));

    if (idiomLinks.length) {
      out.push(
        `<div style="background:#FFF6CC;padding:8px 10px;border-left:4px solid #F7B500;margin:12px 0">`
      );
      out.push(
        `<div style="font-weight:bold;color: #F7B500;font-size:1.05em;margin-bottom:4px">Idioms&nbsp;and&nbsp;phrases</div>`
      );
      idiomLinks.forEach(({ text, href }) =>
        out.push(`<br>• <a href="${href}">${escapeHtml(text)}</a>`)
      );
      out.push(`</div>`, "");
    }
  });

  if (out.length <= 3) {
    out.push("_No content found. Structure may have changed._");
  }
  return out.join("\n");
}


function openDb(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('WORDS','LOOKUPS','BOOK_INFO')"
    )
    .all();
  if (tableCheck.length < 3) {
    db.close();
    throw new Error("DB does not look like a Kindle vocab.db (missing required tables).");
  }
  return db;
}

export function listBooksFromVocab(dbPath) {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT b.id, b.title, b.authors, b.lang,
                COUNT(DISTINCT w.id) AS unique_words,
                COUNT(l.id) AS lookups
           FROM BOOK_INFO b
      LEFT JOIN LOOKUPS l ON l.book_key = b.id
      LEFT JOIN WORDS w   ON w.id       = l.word_key
       GROUP BY b.id
       ORDER BY b.title COLLATE NOCASE ASC`
      )
      .all();
    return rows;
  } finally {
    db.close();
  }
}

function getRowsPerLookup(db, bookId) {
  return db
    .prepare(
      `SELECT l.id       AS kindle_id,
              w.word     AS word,
              l.usage    AS sentence,
              l.timestamp AS ts
         FROM LOOKUPS l
         JOIN WORDS w ON w.id = l.word_key
        WHERE l.book_key = ?
        ORDER BY l.timestamp ASC`
    )
    .all(bookId);
}

function getRowsPerWord(db, bookId) {
  return db
    .prepare(
      `WITH latest AS (
         SELECT l.word_key, MAX(l.timestamp) AS max_ts
           FROM LOOKUPS l
          WHERE l.book_key = ?
          GROUP BY l.word_key
       )
       SELECT w.id       AS kindle_id,
              w.word     AS word,
              (SELECT l2.usage
                 FROM LOOKUPS l2
                WHERE l2.book_key = ? AND l2.word_key = w.id
                ORDER BY l2.timestamp DESC
                LIMIT 1) AS sentence
         FROM WORDS w
         JOIN LOOKUPS l ON l.word_key = w.id AND l.book_key = ?
         JOIN latest lt ON lt.word_key = w.id
        GROUP BY w.id, w.word
        ORDER BY w.word COLLATE NOCASE ASC`
    )
    .all(bookId, bookId, bookId);
}

function pLimit(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((v) => {
        active--;
        resolve(v);
        next();
      })
      .catch((e) => {
        active--;
        reject(e);
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export async function buildApkg({
  emitter,
  dbPath,
  bookId,
  deckName,
  perWord = false,
  noScrape = false,
  concurrency = 4,
  includeSmartVocab = true,
  onProgress = () => {},
  includeLlm = false,
  llmModel = process.env.OLLAMA_MODEL || "phi3:mini", // "qwen2.5:1.5b", // "phi3:mini"
}) {
  // Validate presence
  await fs.access(dbPath);
  const db = openDb(dbPath);
  try {
    const rows = perWord ? getRowsPerWord(db, bookId) : getRowsPerLookup(db, bookId);
    if (!rows.length) throw new Error("No lookups/words found for that book.");

    const apkg = new AnkiExport(deckName || "Kindle Vocab");
    const limit = pLimit(Math.max(1, Math.min(8, Number(concurrency) || 4)));

    let done = 0;
    const total = rows.length;
    const startedAt = Date.now();
    // send an early tick so UI knows the total even before first card finishes
    onProgress({ done, total });
 
    // LLM runner (sequential across all tasks)
    const llmLimit = pLimit(1);
    
    async function runOllama(word, sentence) {
  const prompt = `You are an English explainer.

Input:
Sentence: "${sentence}"
Highlighted: "${word}"

Task:
- If the highlighted word is part of a phrasal verb, explain the full phrasal verb.
- Otherwise, explain the highlighted word as used in the sentence.
- Give a short, clear explanation (1–3 sentences).
- Provide 2–3 short example sentences.
- Output in Markdown only, with this structure:

### <expression>
**Part of speech:** <part of speech>

**Meaning:** <short explanation>

**Examples:**
- <example 1>
- <example 2>
- <example 3>`;  

  // Prefer HTTP if OLLAMA_URL is provided (e.g. http://host.docker.internal:11434)
  if (OLLAMA_URL && /^https?:\/\//i.test(OLLAMA_URL)) {
    try {
      const url = OLLAMA_URL.replace(/\/$/, "") + "/api/generate";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: llmModel,         // uses your existing variable
          prompt,
          stream: false
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.response || "").trim() || "_empty response_";
    } catch (e) {
      return `_LLM HTTP error: ${mdEscape(e.message)}_`;
    }
  }

  // Fallback: spawn CLI if available in PATH
  return await llmLimit(() =>
    new Promise((resolve) => {
      try {
        const child = spawn("ollama", ["run", llmModel], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("close", () => {
          resolve(out.trim() || `_LLM error (${llmModel}): ${mdEscape(err.trim()).slice(0,300)}_`);
        });
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (e) {
        resolve(`_LLM not available: ${mdEscape(e.message)}_`);
      }
    })
  );
}

    // const tasks = rows.map((row) => async () => {
    //   const word = clean(row.word || "");
    //   const sentence = clean(row.sentence || "");
    //   if (!word) return;
    //   const kindleId = String(row.kindle_id || "").trim() || "(no id)";
    //   const frontTitle = `<span style="font-weight: bold">${escapeHtml(word)}</span><br><span style="color:#ccc">${escapeHtml(kindleId)}</span>`;

    //   let md = "";
    //   if (!noScrape) {
    //     try {
    //       md = await scrapeCambridgeMarkdown(word);
    //     } catch (e) {
    //       md = `_Error scraping Cambridge for **${mdEscape(word)}**: ${mdEscape(e.message)}_`;
    //     }
    //   }

    //   const backHtml = `
    //   <div style="text-align:left">
    //     ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
    //     ${noScrape ? "" : "<hr />"}
    //     ${noScrape ? "" : marked.parse(md)}
    //   </div>
    //   `;

    //   apkg.addCard(frontTitle, backHtml);

    //   done += 1;
    //   onProgress({ done, total });
    // });

    let cancelled = false;
    if (emitter) emitter.once("cancel", () => (cancelled = true));

    const tasks = rows.map((row) => async () => {
      if (cancelled) return;  
      const word = clean(row.word || "");
      const sentence = clean(row.sentence || "");
      if (!word) return;

      const kindleId = String(row.kindle_id || "").trim() || "(no id)";
      const surfaceForm = findWordFormInSentence(word, sentence) || word; // exact form from sentence if found

      let md = "";
      if (!noScrape) {
        try {
          md = await scrapeCambridgeMarkdown(word, { includeSmartVocab });
        } catch (e) {
          md = `_Error scraping Cambridge for **${mdEscape(word)}**: ${mdEscape(e.message)}_`;
        }
      }

            // optional LLM enrichment (Markdown), strictly sequential
      let llmMd = "";
      if (includeLlm) {
        try {
          llmMd = await runOllama(word, sentence || "");
        } catch (e) {
          llmMd = `_LLM failed: ${mdEscape(e.message)}_`;
        }
      }

      // FRONT: 1) word, 2) exact form (from sentence), 3) usage: sentence, 4) id
      const FRONT_STYLE = `
        <style>
          .front { font-size:${FONT.basePx}px; line-height:1.35; text-align:left; }
          .front .word { font-size:${FONT.wordEm}em; font-weight:700; margin-bottom:.15em; }
          .front .id { color:#b0bccc; font-size:${FONT.smallEm}em; margin-top:.35em; }
          .front blockquote{
            font-size:${FONT.listEm}em; margin:.25em 0; padding:6px 10px;
            border-left:4px solid ${COLORS.tileBg};
            background: rgba(14,42,71,.08); border-radius:0 8px 8px 0; font-style:italic;
          }
        </style>`;

        const frontTitle = `
        ${FRONT_STYLE}
        <div class="front">
          <div class="word">${escapeHtml(word)}</div>
          ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
          <br /><br />
          <div class="id">${escapeHtml(kindleId)}</div>
        </div>`.trim();

      // const frontTitle = `
      // <div style="text-align:left;line-height:1.35">
      //   <div style="font-weight:700;font-size:1.35em;margin-bottom:.15em">${escapeHtml(word)}</div>
        
      //   ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
      //   <br /><br />
      //   <div style="color:#b0bccc;margin-top:.35em;font-size:.9em">${escapeHtml(kindleId)}</div>
      // </div>`.trim();
      // ${sentence ? `<div><span style="color:#98a6b5">usage:</span> ${escapeHtml(sentence)}</div>` : ""}

      // BACK: styled with constants (tiles/headers, meanings, examples get different colors)
      const style = `
<style>
  .anki {
    --tile-bg:${COLORS.tileBg};
    --tile-text:${COLORS.tileText};
    --tile-border:${COLORS.tileBorder};
    --meaning-bg:${COLORS.meaningBg};
    --meaning-text:${COLORS.meaningText};
    --meaning-ring:${COLORS.meaningRing};
    --example-bg:${COLORS.exampleBg};
    --example-text:${COLORS.exampleText};
    --example-ring:${COLORS.exampleRing};
    font-size:${FONT.basePx}px;            /* ↓ global shrink */
    line-height:1.4;
  }
  .anki h1, .anki h2, .anki h3 {
    font-size:${FONT.headingEm}em;         /* smaller headings */
    background: var(--tile-bg);
    color: var(--tile-text);
    padding: 6px 10px;
    border-left: 4px solid var(--tile-text);
    border-radius: 8px;
    margin: 10px 0 8px 0;
    box-shadow: 0 1px 0 0 var(--tile-border) inset;
  }
  .anki ul { list-style: none; padding-left: 0; margin: 6px 0; }
  .anki ul > li {
    font-size:${FONT.listEm}em;            /* meanings smaller */
    background: var(--meaning-bg);
    color: var(--meaning-text);
    padding: 8px 10px;
    border-radius: 10px;
    margin: 6px 0;
    box-shadow: 0 0 0 1px var(--meaning-ring) inset;
  }
  .anki ul > li > ul { margin-top: 6px; }
  .anki ul > li > ul > li {
    font-size:${FONT.smallEm}em;           /* examples smallest */
    background: var(--example-bg);
    color: var(--example-text);
    padding: 6px 8px;
    border-radius: 8px;
    margin: 6px 0 0 0;
    box-shadow: 0 0 0 1px var(--example-ring) inset;
  }
  .anki blockquote {
    font-size:${FONT.listEm}em;
    margin: 0 0 10px 0; padding: 8px 10px;
    border-left: 4px solid var(--tile-bg);
    background: rgba(14,42,71,.08);
    border-radius: 0 8px 8px 0;
    font-style: italic;
  }
  .anki hr { border: 0; height: 1px; background: var(--tile-border); margin: 10px 0; }
  .anki a { color: #a7d1ff; text-decoration: none; }
  .anki a:hover { text-decoration: underline; }


  .anki .llm { background:#F5F7FF; color:#2B3A55; padding:10px 12px; border-left:4px solid #7B9BFF; border-radius:8px; margin: 8px 0; }
  .anki .divider { height: 2px; margin: 10px 0; background: linear-gradient(90deg,#7B9BFF33,#7B9BFF,#7B9BFF33); border:0; }
 

  /* SMART Vocabulary */
  .anki .smart-vocab{ font-size:${FONT.listEm}em; background: #f0f2f4; color: #5f6b76; padding: 8px 10px; margin: 10px 0; border-radius: 8px; }
  .anki .smart-vocab .smart-title{ font-weight: 600; font-size: .95em; color: #6b7680; margin-bottom: 6px; }
  .anki .smart-vocab ul{ list-style: none; margin: 0; padding: 0; }
  .anki .smart-vocab li{ background: #e6eaee; color: #4a5560; border-radius: 8px; padding: 6px 10px; margin: 6px 0; }

  /* Phrasal / Idioms */
  .anki .phrasal-vocab { font-size:${FONT.listEm}em; background: #e8f3ff; color: #2f4a67; padding: 8px 10px; margin: 10px 0; border-radius: 8px; }
  .anki .phrasal-vocab .phrasal-title { font-weight: 600; font-size: .95em; color: #2a5887; margin-bottom: 6px; }
  .anki .phrasal-vocab ul { list-style: none; margin: 0; padding: 0; }
  .anki .phrasal-vocab li { background: #d6e9ff; color: #243b54; border-radius: 8px; padding: 6px 10px; margin: 6px 0; }
  .anki .phrasal-vocab li.example { background: #c6ddf9; font-style: italic; }
</style>`;


      const backHtml = `
      <div class="anki" style="text-align:left">
        ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
        ${includeLlm && llmMd ? `<div class="llm">${marked.parse(llmMd)}</div><div class="divider"></div>` : ""}
        ${noScrape ? "" : "<hr />"}
        ${noScrape ? "" : style + marked.parse(md)}
      </div>
      `;

      apkg.addCard(frontTitle, backHtml);

      done += 1;
      onProgress({ done, total });
    });


    await Promise.all(tasks.map((t) => limit(t)));
    if (cancelled) throw new Error("__CANCELLED__");

    // anki-apkg-export returns a binary buffer/string. We'll ensure Buffer.
    const zip = await apkg.save();
    const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip, "binary");
    return buf;
  } finally {
    db.close();
  }
}