// Read the Kindle IDs out of an existing .apkg so a new build can skip
// words that are already in the user's Anki deck (same logic as the web app).

import zlib from "node:zlib";
import JSZip from "jszip";
import { openDatabase, all } from "./sqlite.js";

/** Extract Kindle IDs from an .apkg Buffer (the trailing ID on each card's front). */
export async function extractIdsFromApkg(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("This file is not a valid .apkg (not a zip archive).");
  }
  const files = Object.keys(zip.files);

  // Prefer the zstd-compressed collection of newer Anki versions, then legacy names.
  const collName =
    files.find((n) => /^collection\.anki21b$/i.test(n)) ??
    files.find((n) => /^collection\.(anki21|anki2|sqlite)$/i.test(n));
  if (!collName) throw new Error("Invalid .apkg: collection database not found.");

  let dbBuf = await zip.files[collName].async("nodebuffer");
  if (/\.anki21b$/i.test(collName)) {
    try {
      dbBuf = zlib.zstdDecompressSync(dbBuf);
    } catch (e) {
      throw new Error(`Failed to decompress ${collName}: ${e.message}`);
    }
  }

  const db = await openDatabase(dbBuf);
  try {
    const ids = [];
    for (const r of all(db, "SELECT flds FROM notes")) {
      const id = idFromFront(String(r.flds || "").split("\x1f")[0] || "");
      if (id) ids.push(id);
    }
    return Array.from(new Set(ids));
  } catch (e) {
    throw new Error(`Could not read notes from the .apkg: ${e.message}`);
  } finally {
    db.close();
  }
}

export function idFromFront(front) {
  // Prefer the explicit <div class="id">…</div> written by this app / the web app.
  const m = front.match(/<div\s+class=["']id["']\s*>([^<]+)<\/div>/i);
  if (m?.[1]?.trim()) return decodeEntities(m[1].trim());
  // Fallback: the last token outside of tags.
  const stripped = front.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return decodeEntities(stripped.split(" ").pop() ?? "");
}

// Card fronts are HTML-escaped, Kindle IDs in vocab.db are not (e.g. "en:o'clock").
function decodeEntities(s) {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
