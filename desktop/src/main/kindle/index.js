// One entry point for finding Kindles and pulling vocab.db off them.
//
//   Windows  MTP Kindles  -> Windows Shell (portable devices), see windows/
//            USB drive    -> drive letter, plain file read
//   macOS    MTP Kindles  -> our own MTP client over raw USB, see mtp/
//            USB drive    -> /Volumes/<Kindle>, plain file read
//   Linux    same as macOS (MTP may need udev permissions)

import fs from "node:fs/promises";
import path from "node:path";
import { copyVocabFromDevice, scanWindows } from "./windows/windowsShell.js";
import { findMountedKindles } from "./massStorage.js";
import { KINDLE_VENDOR_ID, downloadVocabOverUsb, listUsbKindles, loadUsb } from "./mtp/usbBackend.js";

export { KindleAccessError } from "./mtp/usbBackend.js";

function fromVolume(v) {
  return {
    id: `drive|${v.root}`,
    name: v.label && !/^\s*$/.test(v.label) ? v.label : "Kindle",
    connection: "drive",
    location: v.root,
    vocab: v.vocabSize != null ? "found" : "missing",
    vocabSize: v.vocabSize,
    note: v.vocabSize == null ? "No system/vocabulary/vocab.db on this drive yet." : null,
    source: { type: "drive", vocabPath: v.vocabPath }
  };
}

/**
 * Find connected Kindles. Never opens an MTP session, so it is cheap enough to
 * run whenever something is plugged in.
 * @returns {Promise<{devices: object[], problems: string[]}>}
 */
export async function scanKindles() {
  const devices = [];
  const problems = [];

  if (process.platform === "win32") {
    try {
      const { devices: portable, drives } = await scanWindows();
      for (const d of portable) {
        if (!d.storages.length) {
          devices.push({
            id: `win-mtp|${d.id}`,
            name: d.name,
            connection: "mtp",
            location: "",
            vocab: "unknown",
            note: d.error || "Windows sees the Kindle but no storage yet. Unlock the Kindle and click Scan.",
            source: { type: "win-mtp", deviceId: d.id, storageName: "" }
          });
        }
        for (const s of d.storages) {
          devices.push({
            id: `win-mtp|${d.id}|${s.name}`,
            name: d.name,
            connection: "mtp",
            location: s.name,
            vocab: s.vocabSize != null ? "found" : s.error ? "unknown" : "missing",
            vocabSize: s.vocabSize,
            note: s.error || (s.missing ? `"${s.missing}" is not visible over USB on this Kindle.` : null),
            source: { type: "win-mtp", deviceId: d.id, storageName: s.name }
          });
        }
      }
      devices.push(...drives.map(fromVolume));
    } catch (e) {
      problems.push(`Windows device scan failed: ${e.message}`);
    }
  } else {
    devices.push(...(await findMountedKindles()).map(fromVolume));
    try {
      for (const k of await listUsbKindles()) {
        if (!k.mtp) continue; // a Kindle in USB-drive mode shows up as a volume instead
        devices.push({
          id: `usb-mtp|${k.key}`,
          name: k.name,
          connection: "mtp",
          location: "USB (MTP)",
          vocab: "unknown",
          vocabSize: null,
          note: null,
          source: { type: "usb-mtp", key: k.key, serial: k.serial }
        });
      }
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { devices, problems };
}

/** Number of Kindles on the USB bus (any mode), or null if USB enumeration is unavailable. */
export async function countUsbKindles() {
  try {
    return (await listUsbKindles()).length;
  } catch {
    return null;
  }
}

/**
 * Copy vocab.db off a device returned by scanKindles().
 * @returns {Promise<{bytes: Buffer, method: string, model?: string}>}
 */
export async function extractVocab(device, { tmpDir, log = () => {}, onProgress, releaseCameraDaemon = true } = {}) {
  const src = device.source;
  if (src.type === "drive") {
    return { bytes: await fs.readFile(src.vocabPath), method: "USB drive" };
  }
  if (src.type === "win-mtp") {
    const dest = await fs.mkdtemp(path.join(tmpDir, "kindle-"));
    try {
      const r = await copyVocabFromDevice({ deviceId: src.deviceId, storageName: src.storageName, destDir: dest });
      log(`Windows copied vocab.db (${r.size} bytes) from ${r.storage} in ${r.ms} ms.`);
      return { bytes: await fs.readFile(r.path), method: "MTP via Windows" };
    } finally {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (src.type === "usb-mtp") {
    const kindles = (await listUsbKindles()).filter((k) => k.mtp);
    const k =
      kindles.find((x) => x.key === src.key) ||
      kindles.find((x) => src.serial && x.serial === src.serial) ||
      kindles[0];
    if (!k) throw new Error("The Kindle is no longer connected.");
    const r = await downloadVocabOverUsb(k, { log, onProgress, releaseCameraDaemon });
    return { bytes: r.bytes, method: "MTP over USB", model: r.deviceInfo?.model };
  }
  throw new Error(`Unknown device type ${src.type}`);
}

/**
 * Call onChange() whenever a Kindle is plugged in or removed.
 * Returns an unsubscribe function, or null when hotplug events are unavailable.
 */
export function watchKindleHotplug(onChange) {
  let usb;
  try {
    ({ usb } = loadUsb());
  } catch {
    return null;
  }
  const handler = (event) => {
    if (event?.device?.vendorId === KINDLE_VENDOR_ID) onChange(event.type);
  };
  usb.addEventListener("connect", handler);
  usb.addEventListener("disconnect", handler);
  return () => {
    usb.removeEventListener("connect", handler);
    usb.removeEventListener("disconnect", handler);
  };
}
