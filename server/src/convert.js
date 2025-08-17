// Core conversion logic adapted from your CLI (kindle_vocabdb_to_anki.mjs)
// Exposed as callable functions for the web server.

import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import AnkiExport from "@steve2955/anki-apkg-export";
import { load as cheerioLoad } from "cheerio";
import { marked } from "marked";

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

async function scrapeCambridgeMarkdown(word) {
  const URL = BASE + encodeURIComponent(String(word || "").toLowerCase());
  const html = await fetchHtml(URL);
  const $ = cheerioLoad(html);
  const out = [];
  out.push(`# ${mdEscape(word)} — Cambridge Dictionary`);
  out.push(`*Source:* ${URL}`);
  out.push("");

  $(".entry-body__el").each((_, el) => {
    const $el = $(el);
    const headword = clean($el.find(".pos-header.dpos-h .headword .hw").text()) || word;
    const pos = clean($el.find(".pos-header.dpos-h .pos.dpos").text());
    if (headword || pos) {
      out.push(`## ${mdEscape(headword)}${pos ? ` — *${mdEscape(pos)}*` : ""}`);
      out.push("");
    }

    const senses = [];
    $el
      .find(".def-block.ddef_block")
      .filter((_, b) => $(b).closest(".dphrase-block").length === 0)
      .each((_, b) => {
        const data = extractDefBlock($, $(b));
        if (data) senses.push(data);
      });

    if (senses.length) {
      out.push(`### Meanings`);
      senses.forEach((s) => {
        const badge = s.level && s.level.length <= 5 ? ` **[${s.level}]**` : "";
        out.push(`- **${mdEscape(s.def)}**${badge}`);
        s.examples.forEach((e) => out.push(`  - _${mdEscape(e)}_`));
      });
      out.push("");
    }

    const phraseBlocks = $el.find(".dphrase-block");
    phraseBlocks.each((_, pb) => {
      const $pb = $(pb);
      const title = clean($pb.find(".phrase-head .phrase-title").text());
      const items = [];
      $pb.find(".phrase-body .def-block.ddef_block").each((_, b) => {
        const data = extractDefBlock($, $(b));
        if (data) items.push(data);
      });
      if (!title || !items.length) return;

      out.push(`### Phrase ▸ **${mdEscape(title)}**`);
      items.forEach((it) => {
        const badge = it.level && it.level.length <= 5 ? ` **[${it.level}]**` : "";
        out.push(`- **${mdEscape(it.def)}**${badge}`);
        it.examples.forEach((e) => out.push(`  - _${mdEscape(e)}_`));
      });

      const seeMore = $pb.find(".dbtn a.hbtn.hbtn-tab").attr("href");
      if (seeMore) out.push(`> See more: ${seeMore}`);
      out.push("");
    });
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
  dbPath,
  bookId,
  deckName,
  perWord = false,
  noScrape = false,
  concurrency = 4
}) {
  // Validate presence
  await fs.access(dbPath);
  const db = openDb(dbPath);
  try {
    const rows = perWord ? getRowsPerWord(db, bookId) : getRowsPerLookup(db, bookId);
    if (!rows.length) throw new Error("No lookups/words found for that book.");

    const apkg = new AnkiExport(deckName || "Kindle Vocab");
    const limit = pLimit(Math.max(1, Math.min(8, Number(concurrency) || 4)));

    const tasks = rows.map((row) => async () => {
      const word = clean(row.word || "");
      const sentence = clean(row.sentence || "");
      if (!word) return;
      const kindleId = String(row.kindle_id || "").trim() || "(no id)";
      const frontTitle = `<span style="font-weight: bold">${escapeHtml(word)}</span><br><span style="color:#ccc">${escapeHtml(kindleId)}</span>`;

      let md = "";
      if (!noScrape) {
        try {
          md = await scrapeCambridgeMarkdown(word);
        } catch (e) {
          md = `_Error scraping Cambridge for **${mdEscape(word)}**: ${mdEscape(e.message)}_`;
        }
      }

      const backHtml = `
      <div style="text-align:left">
        ${sentence ? `<blockquote>${escapeHtml(sentence)}</blockquote>` : ""}
        ${noScrape ? "" : "<hr />"}
        ${noScrape ? "" : marked.parse(md)}
      </div>
      `;

      apkg.addCard(frontTitle, backHtml);
    });

    await Promise.all(tasks.map((t) => limit(t)));

    // anki-apkg-export returns a binary buffer/string. We'll ensure Buffer.
    const zip = await apkg.save();
    const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip, "binary");
    return buf;
  } finally {
    db.close();
  }
}