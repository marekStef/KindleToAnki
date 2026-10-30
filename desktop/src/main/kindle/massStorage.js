// Older Kindles show up as a USB drive: vocab.db is a plain file on the volume.
// (On Windows the drive list comes from kindle-shell.ps1, which knows the drive
// types and can skip network drives that would hang a plain fs call.)

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VOCAB_REL_PATH = path.join("system", "vocabulary", "vocab.db");

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))
  ]);
}

async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function candidateRoots() {
  if (process.platform === "darwin") return listDirs("/Volumes");
  if (process.platform === "linux") {
    const user = os.userInfo().username;
    const lists = await Promise.all([`/media/${user}`, `/run/media/${user}`, "/media", "/mnt"].map(listDirs));
    return [...new Set(lists.flat())];
  }
  return [];
}

/** A mounted volume counts as a Kindle when it has vocab.db, or is labelled "Kindle". */
export async function inspectVolume(root, label = path.basename(root)) {
  const vocabPath = path.join(root, VOCAB_REL_PATH);
  let vocabSize = null;
  try {
    vocabSize = (await fs.stat(vocabPath)).size;
  } catch {
    if (!/kindle/i.test(label)) return null;
  }
  return { root, label, vocabPath, vocabSize };
}

export async function findMountedKindles() {
  const roots = await candidateRoots();
  const results = await Promise.all(roots.map((r) => withTimeout(inspectVolume(r), 3000, null)));
  return results.filter(Boolean);
}
