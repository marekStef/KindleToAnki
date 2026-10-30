// Minimal Anki .apkg writer.
//
// This is a port of @steve2955/anki-apkg-export (used by the web app) onto the
// modern sql.js build. The collection template, deck/model ids and note GUIDs
// are derived exactly the same way, so a deck built here and a deck built by the
// web app with the same deck name produce the same note GUIDs in Anki.

import crypto from "node:crypto";
import JSZip from "jszip";
import { openDatabase, get } from "./sqlite.js";

const SEPARATOR = "\u001F";

const sha1 = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
const checksum = (s) => parseInt(sha1(s).slice(0, 8), 16);

export async function createApkg(deckName, templateOptions = {}) {
  const db = await openDatabase();
  db.exec(createTemplate(templateOptions));
  return new ApkgWriter(db, deckName);
}

class ApkgWriter {
  constructor(db, deckName) {
    this.db = db;
    this.deckName = deckName;
    this.topDeckId = parseInt(sha1(deckName).slice(0, 8), 16);
    this.topModelId = this.topDeckId;

    const decks = JSON.parse(get(db, "SELECT decks FROM col").decks);
    const deck = popLastItem(decks);
    deck.name = deckName;
    deck.id = this.topDeckId;
    decks[String(this.topDeckId)] = deck;
    db.run("UPDATE col SET decks = ? WHERE id = 1", [JSON.stringify(decks)]);

    const models = JSON.parse(get(db, "SELECT models FROM col").models);
    const model = popLastItem(models);
    model.name = deckName;
    model.did = this.topDeckId;
    model.id = this.topModelId;
    models[String(this.topModelId)] = model;
    db.run("UPDATE col SET models = ? WHERE id = 1", [JSON.stringify(models)]);

    // The original exporter picks every id/mod as "max(existing) + 1, at least now".
    // We are the only writer, so plain counters give identical results.
    this.last = { noteId: 0, noteMod: 0, cardId: 0, cardMod: 0 };
    this.noteIdByGuid = new Map();
    this.cardIdByNote = new Map();
    this.cardCount = 0;

    this.insertNote = db.prepare(
      "INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    );
    this.insertCard = db.prepare(
      "INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    );
  }

  nextId(key, now) {
    this.last[key] = Math.max(now, this.last[key] + 1);
    return this.last[key];
  }

  addCard(front, back, { tags } = {}) {
    const now = Date.now();
    const guid = sha1(`${this.topDeckId}${front}`);

    let noteId = this.noteIdByGuid.get(guid);
    if (noteId === undefined) {
      noteId = this.nextId("noteId", now);
      this.noteIdByGuid.set(guid, noteId);
    }

    let strTags = "";
    if (typeof tags === "string") strTags = tags;
    else if (Array.isArray(tags) && tags.length) {
      strTags = " " + tags.map((t) => String(t).replace(/ /g, "_")).join(" ") + " ";
    }

    const flds = front + SEPARATOR + back;
    this.insertNote.run([
      noteId,                       // id
      guid,                         // guid
      this.topModelId,              // mid
      this.nextId("noteMod", now),  // mod
      -1,                           // usn
      strTags,                      // tags
      flds,                         // flds
      front,                        // sfld
      checksum(flds),               // csum
      0,                            // flags
      ""                            // data
    ]);

    let cardId = this.cardIdByNote.get(noteId);
    if (cardId === undefined) {
      cardId = this.nextId("cardId", now);
      this.cardIdByNote.set(noteId, cardId);
      this.cardCount += 1;
    }
    this.insertCard.run([
      cardId,                       // id
      noteId,                       // nid
      this.topDeckId,               // did
      0,                            // ord
      this.nextId("cardMod", now),  // mod
      -1,                           // usn
      0, 0, 179,                    // type, queue, due
      0, 0, 0, 0, 0,                // ivl, factor, reps, lapses, left
      0, 0, 0,                      // odue, odid, flags
      ""                            // data
    ]);
  }

  /** Serialise to a .apkg (zip) Buffer. The writer cannot be used afterwards. */
  async save() {
    this.insertNote.free();
    this.insertCard.free();
    const bytes = this.db.export();
    this.db.close();

    const zip = new JSZip();
    zip.file("collection.anki2", Buffer.from(bytes));
    zip.file("media", "{}");
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }

  /** Release the database without producing a file (e.g. after a cancelled job). */
  discard() {
    try { this.insertNote.free(); } catch {}
    try { this.insertCard.free(); } catch {}
    try { this.db.close(); } catch {}
  }
}

function popLastItem(obj) {
  const keys = Object.keys(obj);
  const lastKey = keys[keys.length - 1];
  const item = obj[lastKey];
  delete obj[lastKey];
  return item;
}

// Collection template, copied from anki-apkg-export (schema version 11).
function createTemplate({
  questionFormat = "{{Front}}",
  answerFormat = '{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}',
  css = ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\nbackground-color: white;\n}\n"
} = {}) {
  const conf = {
    nextPos: 1,
    estTimes: true,
    activeDecks: [1],
    sortType: "noteFld",
    timeLim: 0,
    sortBackwards: false,
    addToCur: true,
    curDeck: 1,
    newBury: true,
    newSpread: 0,
    dueCounts: true,
    curModel: "1435645724216",
    collapseTime: 1200
  };

  const models = {
    1388596687391: {
      veArs: [],
      name: "Basic-f15d2",
      tags: ["Tag"],
      did: 1435588830424,
      usn: -1,
      req: [[0, "all", [0]]],
      flds: [
        { name: "Front", media: [], sticky: false, rtl: false, ord: 0, font: "Arial", size: 20 },
        { name: "Back", media: [], sticky: false, rtl: false, ord: 1, font: "Arial", size: 20 }
      ],
      sortf: 0,
      latexPre:
        "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
      tmpls: [
        { name: "Card 1", qfmt: questionFormat, did: null, bafmt: "", afmt: answerFormat, ord: 0, bqfmt: "" }
      ],
      latexPost: "\\end{document}",
      type: 0,
      id: 1388596687391,
      css,
      mod: 1435645658
    }
  };

  const decks = {
    1: {
      desc: "", name: "Default", extendRev: 50, usn: 0, collapsed: false,
      newToday: [0, 0], timeToday: [0, 0], dyn: 0, extendNew: 10, conf: 1,
      revToday: [0, 0], lrnToday: [0, 0], id: 1, mod: 1435645724
    },
    1435588830424: {
      desc: "", name: "Template", extendRev: 50, usn: -1, collapsed: false,
      newToday: [545, 0], timeToday: [545, 0], dyn: 0, extendNew: 10, conf: 1,
      revToday: [545, 0], lrnToday: [545, 0], id: 1435588830424, mod: 1435588830
    }
  };

  const dconf = {
    1: {
      name: "Default",
      replayq: true,
      lapse: { leechFails: 8, minInt: 1, delays: [10], leechAction: 0, mult: 0 },
      rev: { perDay: 100, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, ease4: 1.3, bury: true, minSpace: 1 },
      timer: 0,
      maxTaken: 60,
      usn: 0,
      new: { perDay: 20, delays: [1, 10], separate: true, ints: [1, 4, 7], initialFactor: 2500, bury: true, order: 1 },
      mod: 0,
      id: 1,
      autoplay: true
    }
  };

  const q = (obj) => `'${JSON.stringify(obj).replaceAll("'", "''")}'`;

  return `
    PRAGMA foreign_keys=OFF;
    BEGIN TRANSACTION;
    CREATE TABLE col (
        id integer primary key, crt integer not null, mod integer not null,
        scm integer not null, ver integer not null, dty integer not null,
        usn integer not null, ls integer not null, conf text not null,
        models text not null, decks text not null, dconf text not null,
        tags text not null
    );
    INSERT INTO "col" VALUES(
      1, 1388548800, 1435645724219, 1435645724215, 11, 0, 0, 0,
      ${q(conf)}, ${q(models)}, ${q(decks)}, ${q(dconf)}, '{}'
    );
    CREATE TABLE notes (
        id integer primary key, guid text not null, mid integer not null,
        mod integer not null, usn integer not null, tags text not null,
        flds text not null, sfld integer not null, csum integer not null,
        flags integer not null, data text not null
    );
    CREATE TABLE cards (
        id integer primary key, nid integer not null, did integer not null,
        ord integer not null, mod integer not null, usn integer not null,
        type integer not null, queue integer not null, due integer not null,
        ivl integer not null, factor integer not null, reps integer not null,
        lapses integer not null, left integer not null, odue integer not null,
        odid integer not null, flags integer not null, data text not null
    );
    CREATE TABLE revlog (
        id integer primary key, cid integer not null, usn integer not null,
        ease integer not null, ivl integer not null, lastIvl integer not null,
        factor integer not null, time integer not null, type integer not null
    );
    CREATE TABLE graves (
        usn integer not null, oid integer not null, type integer not null
    );
    ANALYZE sqlite_master;
    INSERT INTO "sqlite_stat1" VALUES('col',NULL,'1');
    CREATE INDEX ix_notes_usn on notes (usn);
    CREATE INDEX ix_cards_usn on cards (usn);
    CREATE INDEX ix_revlog_usn on revlog (usn);
    CREATE INDEX ix_cards_nid on cards (nid);
    CREATE INDEX ix_cards_sched on cards (did, queue, due);
    CREATE INDEX ix_revlog_cid on revlog (cid);
    CREATE INDEX ix_notes_csum on notes (csum);
    COMMIT;
  `;
}
