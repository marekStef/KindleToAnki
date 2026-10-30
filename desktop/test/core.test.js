import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import JSZip from "jszip";
import { buildVocabDb } from "./helpers/vocabFixture.js";
import { openVocab, listBooks, getRows, previewStats, summarize } from "../src/main/core/vocab.js";
import { createApkg } from "../src/main/core/apkgWriter.js";
import { extractIdsFromApkg } from "../src/main/core/apkgIds.js";
import { buildDeck, buildFront, CancelledError } from "../src/main/core/cards.js";
import { openDatabase, all } from "../src/main/core/sqlite.js";

test("lists books with word/lookup counts", async () => {
  const db = await openVocab(await buildVocabDb());
  try {
    const books = listBooks(db);
    assert.deepEqual(
      books.map((b) => [b.title, b.unique_words, b.lookups, b.last_ts]),
      [
        ["Bleak House", 1, 1, 5000],
        ["The Great Gatsby", 3, 4, 4000],
        ["Unread Book", 0, 0, null]
      ]
    );
    assert.deepEqual(summarize(db), { books: 3, words: 4, lookups: 5, firstTs: 1000, lastTs: 5000 });
  } finally {
    db.close();
  }
});

test("rows per lookup vs per word (latest sentence wins)", async () => {
  const db = await openVocab(await buildVocabDb());
  try {
    assert.deepEqual(getRows(db, "B1", false).map((r) => r.kindle_id), ["L1", "L2", "L3", "L4"]);
    const perWord = getRows(db, "B1", true);
    assert.deepEqual(perWord.map((r) => r.kindle_id), ["en:o'clock", "en:recoil", "en:sordid"]);
    assert.equal(perWord.find((r) => r.word === "sordid").sentence, "The sordid details came out later.");
    assert.deepEqual(previewStats(db, { bookId: "B1", perWord: false, existingIds: ["L1", "L4", "nope"] }), {
      uniqueWords: 3,
      entries: 4,
      overlap: 2,
      added: 2
    });
  } finally {
    db.close();
  }
});

test("rejects files that are not a Kindle vocab.db", async () => {
  await assert.rejects(openVocab(Buffer.from("definitely not sqlite")), /not a Kindle vocab\.db/);
  const empty = await openDatabase();
  const bytes = Buffer.from(empty.export());
  empty.close();
  await assert.rejects(openVocab(bytes), /missing table/);
});

async function readCollection(apkgBuffer) {
  const zip = await JSZip.loadAsync(apkgBuffer);
  const db = await openDatabase(await zip.file("collection.anki2").async("nodebuffer"));
  return { zip, db };
}

test("writes an Anki collection the same way anki-apkg-export does", async () => {
  const apkg = await createApkg("The Great Gatsby — F. Scott Fitzgerald [en]");
  apkg.addCard(buildFront({ word: "sordid", sentence: "A sordid affair.", kindleId: "L1" }), "back 1");
  apkg.addCard(buildFront({ word: "recoil", sentence: "", kindleId: "L2" }), "back 2", { tags: ["kindle", "two words"] });
  const { zip, db } = await readCollection(await apkg.save());
  try {
    assert.equal(await zip.file("media").async("string"), "{}");
    const notes = all(db, "SELECT guid, mid, tags, flds FROM notes ORDER BY id");
    const cards = all(db, "SELECT nid, did, due FROM cards");
    assert.equal(notes.length, 2);
    assert.equal(cards.length, 2);
    assert.equal(notes[1].tags, " kindle two_words ");
    const col = all(db, "SELECT decks, models FROM col")[0];
    const decks = JSON.parse(col.decks);
    const models = JSON.parse(col.models);
    const deck = Object.values(decks).find((d) => d.name.startsWith("The Great Gatsby"));
    assert.ok(deck, "deck renamed from the template");
    assert.equal(cards[0].did, deck.id);
    assert.equal(models[String(deck.id)].name, deck.name);
    assert.equal(notes[0].mid, deck.id);
    // Same derivation as anki-apkg-export: deck id = first 8 hex chars of sha1(deckName),
    // note guid = sha1(deckId + front).
    const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
    assert.equal(deck.id, parseInt(sha1(deck.name).slice(0, 8), 16));
    assert.equal(notes[0].guid, sha1(`${deck.id}${notes[0].flds.split("\x1f")[0]}`));
  } finally {
    db.close();
  }
});

test("extracts Kindle ids from .apkg files, including zstd-compressed .anki21b", async () => {
  const apkg = await createApkg("Deck");
  for (const id of ["L1", "en:o'clock", "CR!ABC:AcAD:12:3"]) {
    apkg.addCard(buildFront({ word: "w", sentence: "s", kindleId: id }), "b");
  }
  const legacy = await apkg.save();
  assert.deepEqual((await extractIdsFromApkg(legacy)).sort(), ["CR!ABC:AcAD:12:3", "L1", "en:o'clock"]);

  // Newer Anki exports: zstd-compressed collection.anki21b
  const src = await JSZip.loadAsync(legacy);
  const collection = await src.file("collection.anki2").async("nodebuffer");
  const modern = new JSZip();
  modern.file("collection.anki21b", zlib.zstdCompressSync(collection));
  modern.file("collection.anki2", Buffer.from("placeholder"));
  const modernBuf = await modern.generateAsync({ type: "nodebuffer" });
  assert.deepEqual((await extractIdsFromApkg(modernBuf)).sort(), ["CR!ABC:AcAD:12:3", "L1", "en:o'clock"]);

  await assert.rejects(extractIdsFromApkg(Buffer.from("nope")), /not a valid \.apkg/);
});

test("buildDeck makes one card per lookup, skips known ids, writes markdown", async () => {
  const vocabBytes = await buildVocabDb();
  const progress = [];
  const res = await buildDeck({
    vocabBytes,
    bookId: "B1",
    deckName: "Gatsby",
    bookTitle: "The Great Gatsby",
    noScrape: true,
    existingIds: ["L2"],
    explain: async ({ word }) => `**${word}** explained`,
    onProgress: (p) => progress.push(p)
  });
  assert.equal(res.newCards, 3);
  assert.equal(res.totalRows, 4);
  assert.deepEqual(res.exportedIds.sort(), ["L1", "L3", "L4"]);
  assert.deepEqual(progress.at(-1), { done: 3, total: 3 });
  assert.match(res.markdown, /## sordid/);
  assert.match(res.markdown, /### Explanation \(LLM\)/);
  assert.deepEqual((await extractIdsFromApkg(res.apkg)).sort(), ["L1", "L3", "L4"]);

  const { db } = await readCollection(res.apkg);
  try {
    const back = all(db, "SELECT flds FROM notes")[0].flds.split("\x1f")[1];
    assert.match(back, /<div class="llm"><p><strong>/);
    assert.doesNotMatch(back, /<hr \/>/); // noScrape: no Cambridge section
  } finally {
    db.close();
  }
});

test("buildDeck explains when everything was exported before", async () => {
  await assert.rejects(
    buildDeck({ vocabBytes: await buildVocabDb(), bookId: "B2", deckName: "x", noScrape: true, existingIds: ["L5"] }),
    /already in your previous decks/
  );
});

test("buildDeck can be cancelled", async () => {
  const ac = new AbortController();
  const p = buildDeck({
    vocabBytes: await buildVocabDb(),
    bookId: "B1",
    deckName: "x",
    noScrape: true,
    explain: async () => {
      ac.abort();
      return "slow";
    },
    signal: ac.signal
  });
  await assert.rejects(p, (e) => e instanceof CancelledError);
});
