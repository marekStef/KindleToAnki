// Reading the Kindle Vocabulary Builder database (system/vocabulary/vocab.db).
// Queries mirror server/src/convert.js so the desktop app builds the same cards
// (and the same Kindle IDs) as the web app.

import { openDatabase, all, get } from "./sqlite.js";

const REQUIRED_TABLES = ["WORDS", "LOOKUPS", "BOOK_INFO"];

/** Open vocab.db bytes and make sure it really is a Kindle vocabulary database. */
export async function openVocab(bytes) {
  const db = await openDatabase(bytes);
  try {
    const names = all(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    const missing = REQUIRED_TABLES.filter((t) => !names.includes(t));
    if (missing.length) {
      throw new Error(`missing table(s) ${missing.join(", ")}`);
    }
  } catch (e) {
    db.close();
    throw new Error(`This is not a Kindle vocab.db (${e.message}).`);
  }
  return db;
}

/** Whole-database counters for the header of the library view. */
export function summarize(db) {
  const row = get(
    db,
    `SELECT (SELECT COUNT(*) FROM BOOK_INFO) AS books,
            (SELECT COUNT(*) FROM WORDS)     AS words,
            (SELECT COUNT(*) FROM LOOKUPS)   AS lookups,
            (SELECT MIN(timestamp) FROM LOOKUPS) AS firstTs,
            (SELECT MAX(timestamp) FROM LOOKUPS) AS lastTs`
  );
  return {
    books: row?.books ?? 0,
    words: row?.words ?? 0,
    lookups: row?.lookups ?? 0,
    firstTs: row?.firstTs ?? null,
    lastTs: row?.lastTs ?? null
  };
}

export function listBooks(db) {
  return all(
    db,
    `SELECT b.id, b.title, b.authors, b.lang, b.asin,
            COUNT(DISTINCT w.id) AS unique_words,
            COUNT(l.id)          AS lookups,
            MIN(l.timestamp)     AS first_ts,
            MAX(l.timestamp)     AS last_ts
       FROM BOOK_INFO b
  LEFT JOIN LOOKUPS l ON l.book_key = b.id
  LEFT JOIN WORDS w   ON w.id       = l.word_key
   GROUP BY b.id
   ORDER BY b.title COLLATE NOCASE ASC`
  );
}

export function getBook(db, bookId) {
  return get(db, "SELECT id, title, authors, lang, asin FROM BOOK_INFO WHERE id = ?", [bookId]);
}

/** One row per lookup (the same word can appear several times with different sentences). */
export function getRowsPerLookup(db, bookId) {
  return all(
    db,
    `SELECT l.id        AS kindle_id,
            w.word      AS word,
            w.stem      AS stem,
            l.usage     AS sentence,
            l.timestamp AS ts
       FROM LOOKUPS l
       JOIN WORDS w ON w.id = l.word_key
      WHERE l.book_key = ?
      ORDER BY l.timestamp ASC`,
    [bookId]
  );
}

/** One row per unique word, using the most recent sentence it was looked up in. */
export function getRowsPerWord(db, bookId) {
  return all(
    db,
    `WITH latest AS (
       SELECT l.word_key, MAX(l.timestamp) AS max_ts
         FROM LOOKUPS l
        WHERE l.book_key = ?
        GROUP BY l.word_key
     )
     SELECT w.id      AS kindle_id,
            w.word    AS word,
            w.stem    AS stem,
            (SELECT l2.usage
               FROM LOOKUPS l2
              WHERE l2.book_key = ? AND l2.word_key = w.id
              ORDER BY l2.timestamp DESC
              LIMIT 1) AS sentence,
            lt.max_ts AS ts
       FROM WORDS w
       JOIN LOOKUPS l ON l.word_key = w.id AND l.book_key = ?
       JOIN latest lt ON lt.word_key = w.id
      GROUP BY w.id, w.word
      ORDER BY w.word COLLATE NOCASE ASC`,
    [bookId, bookId, bookId]
  );
}

export function getRows(db, bookId, perWord) {
  return perWord ? getRowsPerWord(db, bookId) : getRowsPerLookup(db, bookId);
}

/** Counters for the "what will be built" summary above the Build button. */
export function previewStats(db, { bookId, perWord = false, existingIds = [] }) {
  const rows = getRows(db, bookId, perWord);
  const uniqueWords = perWord ? rows.length : getRowsPerWord(db, bookId).length;
  const known = new Set(existingIds.map((s) => String(s).trim()).filter(Boolean));
  let overlap = 0;
  for (const r of rows) if (known.has(String(r.kindle_id ?? "").trim())) overlap++;
  return {
    uniqueWords,
    entries: rows.length,
    overlap,
    added: Math.max(0, rows.length - overlap)
  };
}
