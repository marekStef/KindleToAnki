// Card building: Cambridge scrape, optional LLM explanation, Anki card HTML and
// the Markdown companion file. Ported from server/src/convert.js so cards look
// exactly like the ones the web app produces.

import { load as cheerioLoad } from "cheerio";
import { marked } from "marked";
import { createApkg } from "./apkgWriter.js";
import { openVocab, getRows } from "./vocab.js";

export class CancelledError extends Error {
  constructor() {
    super("Job cancelled by user.");
    this.name = "CancelledError";
  }
}

const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
const mdEscape = (s) => (s || "").replace(/([_*`~])/g, "\\$1");
const escapeHtml = (s = "") =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// Colors for the BACK side (headers/tiles, meanings, examples)
const COLORS = {
  tileBg: "#0E2A47",
  tileText: "#E6F1FF",
  tileBorder: "rgba(255,255,255,0.12)",
  meaningBg: "#1B3B5F",
  meaningText: "#EAF4FF",
  meaningRing: "rgba(230,241,255,.18)",
  exampleBg: "#112D3A",
  exampleText: "#CDE9FF",
  exampleRing: "rgba(205,233,255,.16)"
};

const FONT = {
  basePx: 15,
  headingEm: 1.05,
  wordEm: 1.2,
  listEm: 0.95,
  smallEm: 0.9
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  "Accept-Language": "en"
};
const CAMBRIDGE = "https://dictionary.cambridge.org/dictionary/english/";

async function fetchHtml(url, { tries = 3, signal } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return await res.text();
    } catch (e) {
      if (signal?.aborted) throw new CancelledError();
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr || new Error("fetch failed");
}

export async function scrapeCambridgeMarkdown(word, { includeSmartVocab = true, signal } = {}) {
  const url = CAMBRIDGE + encodeURIComponent(String(word || "").toLowerCase());
  const html = await fetchHtml(url, { signal });
  const $ = cheerioLoad(html);
  const absUrl = (h) => (h && h.startsWith("/") ? "https://dictionary.cambridge.org" + h : h);

  function extractDefBlock($block) {
    const level = clean($block.find(".ddef_h .def-info").text());
    const def = clean($block.find(".ddef_h .def.ddef_d.db").text());
    if (!def) return null;
    const examples = [];
    $block.find(".def-body.ddef_b .examp.dexamp").each((_, exWrap) => {
      const lu = clean($(exWrap).find(".lu.dlu").text());
      const sent = clean($(exWrap).find(".eg.deg").text());
      if (sent) examples.push(lu ? `**${mdEscape(lu)}** — ${mdEscape(sent)}` : mdEscape(sent));
    });
    return { def, level: level || null, examples };
  }

  const out = [];
  out.push(`# ${mdEscape(word)} — Cambridge Dictionary`);
  out.push(`*Source:* ${url}`);
  out.push("");

  $(".entry-body__el").each((_, el) => {
    const $el = $(el);
    const head = clean($el.find(".pos-header.dpos-h .headword .hw").text()) || word;
    const pos = clean($el.find(".pos-header.dpos-h .pos.dpos").text());
    if (head || pos) {
      out.push(`## ${mdEscape(head)}${pos ? ` — *${mdEscape(pos)}*` : ""}`);
      out.push("");
    }

    // Meanings
    const senses = [];
    $el
      .find(".def-block.ddef_block")
      .filter((_, b) => $(b).closest(".dphrase-block").length === 0)
      .each((_, b) => {
        const d = extractDefBlock($(b));
        if (d) senses.push(d);
      });
    if (senses.length) {
      senses.forEach((s) => {
        const badge = s.level && s.level.length <= 5 ? ` **[${s.level}]**` : "";
        out.push(`- **${mdEscape(s.def)}**${badge}`);
        s.examples.forEach((e) => out.push(`  - _${mdEscape(e)}_`));
      });
      out.push("");
    }

    // Phrasal verbs / idioms inside the entry
    $el.find(".dphrase-block").each((_, b) => {
      const $b = $(b);
      const title = clean($b.find(".phrase-head .phrase-title").text());
      const items = [];
      $b.find(".phrase-body .def-block.ddef_block").each((_, d) => {
        const dblk = extractDefBlock($(d));
        if (dblk) items.push(dblk);
      });
      if (!title || !items.length) return;

      out.push(
        `<div class="phrasal-vocab">` +
          `<div class="phrasal-title">Phrase ▸ <strong>${escapeHtml(title)}</strong></div>` +
          `<ul>` +
          items
            .map((it) => {
              const badge =
                it.level && it.level.length <= 5 ? ` <span class="level">[${escapeHtml(it.level)}]</span>` : "";
              const examples = it.examples.map((e) => `<li class="example">${escapeHtml(e)}</li>`).join("");
              return `<li>${escapeHtml(it.def)}${badge}${examples ? `<ul>${examples}</ul>` : ""}</li>`;
            })
            .join("") +
          `</ul>` +
          `</div>`,
        ""
      );

      const seeMore = $b.find(".dbtn a.hbtn.hbtn-tab").attr("href");
      if (seeMore) out.push(`> See more: ${absUrl(seeMore)}`);
      out.push("");
    });

    // SMART Vocabulary box
    if (includeSmartVocab) {
      $el.find(".smartt.daccord section").each((_, sec) => {
        const $sec = $(sec);
        const topic = clean($sec.find(".daccord_lt a").first().text());
        const links = [];
        $sec.find(".daccord_lb li a").each((_, a) => {
          const $a = $(a);
          const text = clean($a.find(".phrase, .base").text() || $a.text());
          const href = absUrl($a.attr("href"));
          if (text && href) links.push({ text, href });
        });
        if (!topic || !links.length) return;
        out.push(
          `<div class="smart-vocab">` +
            `<div class="smart-title">SMART Vocabulary ▸ <em>${escapeHtml(topic)}</em></div>` +
            `<ul>` +
            links.map(({ text, href }) => `<li><a href="${href}">${escapeHtml(text)}</a></li>`).join("") +
            `</ul>` +
            `</div>`,
          ""
        );
      });
    }

    // Idioms & phrases (sidebar + accordion)
    const idiomLinks = [];
    const seen = new Set();
    const add = (text, href) => {
      if (!text || !href) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      idiomLinks.push({ text, href });
    };
    const grabText = ($a) => {
      const phrase = clean($a.find(".phrase").first().text());
      const base = clean($a.find(".base").first().text());
      return phrase || base || clean($a.text());
    };
    $(".xref.idioms a").each((_, a) => add(grabText($(a)), absUrl($(a).attr("href"))));
    $("header:contains('Idioms and phrases')")
      .next("div")
      .find("a")
      .each((_, a) => add(grabText($(a)), absUrl($(a).attr("href"))));

    if (idiomLinks.length) {
      out.push(`<div style="background:#FFF6CC;padding:8px 10px;border-left:4px solid #F7B500;margin:12px 0">`);
      out.push(
        `<div style="font-weight:bold;color: #F7B500;font-size:1.05em;margin-bottom:4px">Idioms&nbsp;and&nbsp;phrases</div>`
      );
      idiomLinks.forEach(({ text, href }) => out.push(`<br>• <a href="${href}">${escapeHtml(text)}</a>`));
      out.push(`</div>`, "");
    }
  });

  if (out.length <= 3) out.push("_No content found. Structure may have changed._");
  return out.join("\n");
}

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

const BACK_STYLE = `
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
    font-size:${FONT.basePx}px;
    line-height:1.4;
  }
  .anki h1, .anki h2, .anki h3 {
    font-size:${FONT.headingEm}em;
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
    font-size:${FONT.listEm}em;
    background: var(--meaning-bg);
    color: var(--meaning-text);
    padding: 8px 10px;
    border-radius: 10px;
    margin: 6px 0;
    box-shadow: 0 0 0 1px var(--meaning-ring) inset;
  }
  .anki ul > li > ul { margin-top: 6px; }
  .anki ul > li > ul > li {
    font-size:${FONT.smallEm}em;
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

export function buildFront({ word, sentence, kindleId }) {
  return `
        ${FRONT_STYLE}
        <div class="front">
          <div class="word">${escapeHtml(word)}</div>
          ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
          <br /><br />
          <div class="id">${escapeHtml(kindleId)}</div>
        </div>`.trim();
}

export function buildBack({ sentence, llmMd, scrapedMd, noScrape }) {
  return `
      <div class="anki" style="text-align:left">
        ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
        ${llmMd ? `<div class="llm">${marked.parse(llmMd)}</div><div class="divider"></div>` : ""}
        ${noScrape ? "" : "<hr />"}
        ${noScrape ? "" : BACK_STYLE + marked.parse(scrapedMd || "")}
      </div>
      `;
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
      .then(
        (v) => { active--; resolve(v); next(); },
        (e) => { active--; reject(e); next(); }
      );
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/**
 * Build an .apkg + Markdown for one book.
 *
 * @param {object} o
 * @param {Uint8Array} o.vocabBytes   contents of vocab.db
 * @param {(p:{done:number,total:number})=>void} [o.onProgress]
 * @param {(entry:object)=>void} [o.onLog]
 * @param {AbortSignal} [o.signal]    abort to cancel the job
 * @param {(args:{word:string,sentence:string,signal?:AbortSignal})=>Promise<string>} [o.explain]  LLM hook
 */
export async function buildDeck({
  vocabBytes,
  bookId,
  deckName,
  bookTitle = "",
  perWord = false,
  noScrape = false,
  concurrency = 1,
  includeSmartVocab = true,
  existingIds = null,
  explain = null,
  llmModel = null,
  onProgress = () => {},
  onLog = () => {},
  signal
}) {
  const db = await openVocab(vocabBytes);
  let rowsAll;
  try {
    rowsAll = getRows(db, bookId, perWord);
  } finally {
    db.close();
  }

  const existingSet = new Set((existingIds || []).map((s) => String(s).trim()).filter(Boolean));
  const rows = existingSet.size ? rowsAll.filter((r) => !existingSet.has(String(r.kindle_id || "").trim())) : rowsAll;
  if (!rows.length) {
    throw new Error(
      rowsAll.length ? "Every word of this book is already in your previous decks — nothing new to add." : "No lookups/words found for that book."
    );
  }

  const apkg = await createApkg(deckName || "Kindle Vocab");
  const limit = pLimit(Math.max(1, Math.min(8, Number(concurrency) || 1)));
  const llmLimit = pLimit(1); // LLM calls run one at a time
  const total = rows.length;
  let done = 0;
  const exportedIds = [];
  onProgress({ done, total });

  const mdParts = [];
  mdParts.push(`# ${escapeHtml(deckName)}\n`);
  if (bookTitle) mdParts.push(`**Book:** ${escapeHtml(bookTitle)}\n`);
  mdParts.push(`**Generated:** ${new Date().toISOString()}\n`);
  mdParts.push(`\n---\n`);

  const tasks = rows.map((row) => async () => {
    if (signal?.aborted) return;
    const word = clean(row.word || "");
    const sentence = clean(row.sentence || "");
    if (!word) return;
    const kindleId = String(row.kindle_id || "").trim() || "(no id)";

    let md = "";
    if (!noScrape) {
      try {
        md = await scrapeCambridgeMarkdown(word, { includeSmartVocab, signal });
      } catch (e) {
        if (e instanceof CancelledError || signal?.aborted) return;
        onLog({ level: "error", scope: "scrape", word, message: `Cambridge scrape failed: ${String(e.message)}` });
        md = `_Error scraping Cambridge for **${mdEscape(word)}**: ${mdEscape(e.message)}_`;
      }
    }

    let llmMd = "";
    if (explain) {
      try {
        llmMd = await llmLimit(() => (signal?.aborted ? "" : explain({ word, sentence, signal })));
      } catch (e) {
        if (signal?.aborted) return;
        onLog({ level: "error", scope: "llm", word, model: llmModel, message: `LLM failed: ${String(e.message)}` });
        llmMd = `_LLM failed: ${String(e.message)}_`;
      }
    }
    if (signal?.aborted) return;

    apkg.addCard(buildFront({ word, sentence, kindleId }), buildBack({ sentence, llmMd, scrapedMd: md, noScrape }));
    exportedIds.push(kindleId);

    const lines = [];
    lines.push(`\n\n## ${mdEscape(word)}`);
    if (sentence) lines.push(`\n> ${mdEscape(sentence)}`);
    if (llmMd) {
      lines.push(`\n\n### Explanation (LLM)\n`);
      lines.push(llmMd.trim());
    }
    if (!noScrape && md) {
      lines.push(`\n\n<details><summary>Cambridge extract</summary>\n\n`);
      lines.push(md.trim());
      lines.push(`\n\n</details>`);
    }
    lines.push(`\n\n---`);
    mdParts.push(lines.join(""));

    done += 1;
    onProgress({ done, total });
  });

  try {
    await Promise.all(tasks.map((t) => limit(t)));
    if (signal?.aborted) throw new CancelledError();
  } catch (e) {
    apkg.discard();
    throw e;
  }

  const newCards = apkg.cardCount;
  const apkgBuffer = await apkg.save();
  return { apkg: apkgBuffer, markdown: mdParts.join("\n"), newCards, exportedIds, totalRows: rowsAll.length };
}
