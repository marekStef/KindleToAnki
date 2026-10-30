// Builds a small vocab.db with the same schema as a real Kindle (firmware 5.17).

import { openDatabase } from "../../src/main/core/sqlite.js";

export async function buildVocabDb() {
  const db = await openDatabase();
  db.exec(`
    CREATE TABLE WORDS (id TEXT PRIMARY KEY NOT NULL UNIQUE, word TEXT, stem TEXT, lang TEXT,
                        category INTEGER DEFAULT 0, timestamp INTEGER DEFAULT 0, profileid TEXT);
    CREATE TABLE LOOKUPS (id TEXT PRIMARY KEY NOT NULL, word_key TEXT, book_key TEXT, dict_key TEXT,
                          pos TEXT, usage TEXT, timestamp INTEGER DEFAULT 0);
    CREATE TABLE BOOK_INFO (id TEXT PRIMARY KEY NOT NULL, asin TEXT, guid TEXT, lang TEXT,
                            title TEXT, authors TEXT);
    CREATE TABLE DICT_INFO (id TEXT PRIMARY KEY NOT NULL, asin TEXT, langin TEXT, langout TEXT);
    CREATE TABLE METADATA (id TEXT PRIMARY KEY NOT NULL, dsname TEXT, sscnt INTEGER, profileid TEXT);
    CREATE TABLE VERSION (id TEXT PRIMARY KEY NOT NULL, dsname TEXT, value INTEGER);
  `);
  const words = [
    ["en:sordid", "sordid", "sordid"],
    ["en:recoil", "recoiled", "recoil"],
    ["en:o'clock", "o'clock", "o'clock"],
    ["en:lugubrious", "lugubrious", "lugubrious"]
  ];
  for (const [id, word, stem] of words) db.run("INSERT INTO WORDS VALUES (?,?,?,?,0,0,'')", [id, word, stem, "en"]);
  db.run("INSERT INTO BOOK_INFO VALUES ('B1','ASIN1','g1','en','The Great Gatsby','F. Scott Fitzgerald')");
  db.run("INSERT INTO BOOK_INFO VALUES ('B2','ASIN2','g2','en','Bleak House','Charles Dickens')");
  db.run("INSERT INTO BOOK_INFO VALUES ('B3','ASIN3','g3','en','Unread Book','Nobody')");
  const lookups = [
    ["L1", "en:sordid", "B1", "A sordid little affair.", 1000],
    ["L2", "en:recoil", "B1", "He recoiled from the touch.", 2000],
    ["L3", "en:sordid", "B1", "The sordid details came out later.", 3000],
    ["L4", "en:o'clock", "B1", "It was nine o'clock.", 4000],
    ["L5", "en:lugubrious", "B2", "A lugubrious expression.", 5000]
  ];
  for (const [id, wordKey, bookKey, usage, ts] of lookups) {
    db.run("INSERT INTO LOOKUPS VALUES (?,?,?,?,?,?,?)", [id, wordKey, bookKey, "dict", "0", usage, ts]);
  }
  const bytes = db.export();
  db.close();
  return Buffer.from(bytes);
}
