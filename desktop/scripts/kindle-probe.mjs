#!/usr/bin/env node
// Find connected Kindles and (optionally) copy vocab.db off one, using the same
// code as the app but without the UI. Handy for debugging device access:
//
//   npm run probe                          list Kindles
//   npm run probe -- --extract [out.db]    copy vocab.db from the first Kindle
//   npm run probe -- --extract out.db --no-release   (macOS) don't stop ptpcamerad

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractVocab, scanKindles } from "../src/main/kindle/index.js";
import { openVocab, summarize } from "../src/main/core/vocab.js";

const args = process.argv.slice(2);
const extractAt = args.indexOf("--extract");
const log = (m) => console.log(`  · ${m}`);

console.log(`Scanning for Kindles (${process.platform}/${process.arch})…`);
const { devices, problems } = await scanKindles();
for (const p of problems) console.log(`  ! ${p}`);
if (!devices.length) {
  console.log("No Kindle found. Is it plugged in and unlocked?");
  process.exit(1);
}
for (const [i, d] of devices.entries()) {
  console.log(`  [${i}] ${d.name} (${d.connection}${d.location ? `, ${d.location}` : ""}) vocab.db: ${d.vocab}${d.vocabSize ? ` (${d.vocabSize} bytes)` : ""}${d.note ? ` (${d.note})` : ""}`);
}

if (extractAt >= 0) {
  const out = path.resolve(args[extractAt + 1] && !args[extractAt + 1].startsWith("--") ? args[extractAt + 1] : "vocab.db");
  const device = devices.find((d) => d.vocab !== "missing") || devices[0];
  console.log(`Copying vocab.db from ${device.name}…`);
  const started = Date.now();
  let showedProgress = false;
  try {
    const { bytes, method } = await extractVocab(device, {
      tmpDir: os.tmpdir(),
      log,
      releaseCameraDaemon: !args.includes("--no-release"),
      onProgress: (done, total) => {
        showedProgress = true;
        process.stdout.write(`\r  · ${Math.round((done / total) * 100)}%   `);
      }
    });
    if (showedProgress) process.stdout.write("\n");
    await fs.writeFile(out, bytes);
    const db = await openVocab(bytes);
    const s = summarize(db);
    db.close();
    console.log(`Saved ${bytes.length} bytes to ${out} via ${method} in ${Date.now() - started} ms: ${s.books} books, ${s.words} words, ${s.lookups} lookups.`);
  } catch (e) {
    console.error(`Failed: ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`);
    process.exit(1);
  }
}
