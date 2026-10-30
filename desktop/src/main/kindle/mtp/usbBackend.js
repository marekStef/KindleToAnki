// Raw-USB MTP backend (macOS and Linux). On Windows the Kindle is bound to the
// system MTP driver, so there we go through the Windows Shell instead.

import { createRequire } from "node:module";
import { MtpSession } from "./session.js";
import { UsbBulkTransport } from "./usbTransport.js";
import { findUsbExclusiveOwners, isCameraDaemon, runningMtpApps, stopCameraDaemons } from "./macos.js";

const require = createRequire(import.meta.url);

export const KINDLE_VENDOR_ID = 0x1949; // Lab126 (Amazon)
export const VOCAB_PATH = ["system", "vocabulary", "vocab.db"];

const USB_CLASS_STILL_IMAGE = 0x06;
const USB_CLASS_MASS_STORAGE = 0x08;
const USB_CLASS_VENDOR = 0xff;

export class KindleAccessError extends Error {
  constructor(message, { hint, cause } = {}) {
    super(message, { cause });
    this.name = "KindleAccessError";
    this.hint = hint;
  }
}

let usbModule = null;
let usbLoadError = null;

/** The native `usb` module, or throws a readable error if it could not be loaded. */
export function loadUsb() {
  if (usbModule) return usbModule;
  if (!usbLoadError) {
    try {
      usbModule = require("usb");
      return usbModule;
    } catch (e) {
      usbLoadError = new Error(`USB support could not be loaded (${e.message}).`);
    }
  }
  throw usbLoadError;
}

const safe = (fn, fallback = null) => {
  try {
    const v = fn();
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

function alternates(device) {
  const config = safe(() => device.configuration) || safe(() => device.configurations?.[0]);
  const out = [];
  for (const iface of config?.interfaces || []) {
    const alts = iface.alternates?.length ? iface.alternates : [iface.alternate];
    for (const alt of alts.filter(Boolean)) out.push({ iface, alt });
  }
  return out;
}

/**
 * Locate the MTP interface: Android-style vendor class with an "MTP" interface
 * string (what Kindles use), or a standard PTP still-image interface.
 */
export function findMtpInterface(device) {
  for (const { iface, alt } of alternates(device)) {
    const name = alt.interfaceName || "";
    const looksMtp =
      (alt.interfaceClass === USB_CLASS_VENDOR && (/\bmtp\b/i.test(name) || device.vendorId === KINDLE_VENDOR_ID)) ||
      (alt.interfaceClass === USB_CLASS_STILL_IMAGE && alt.interfaceSubclass === 1 && alt.interfaceProtocol === 1);
    if (!looksMtp) continue;
    const bulkIn = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "in");
    const bulkOut = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "out");
    if (!bulkIn || !bulkOut) continue;
    return {
      interfaceNumber: iface.interfaceNumber,
      alternateSetting: alt.alternateSetting,
      inEndpoint: bulkIn.endpointNumber,
      outEndpoint: bulkOut.endpointNumber,
      packetSize: bulkIn.packetSize,
      interfaceClass: alt.interfaceClass,
      interfaceName: name
    };
  }
  return null;
}

const hasMassStorage = (device) => alternates(device).some(({ alt }) => alt.interfaceClass === USB_CLASS_MASS_STORAGE);

/** Kindles currently on the USB bus (no device is opened). */
export async function listUsbKindles() {
  const { usb } = loadUsb();
  const devices = await usb.getDevices();
  return devices
    .filter((d) => d.vendorId === KINDLE_VENDOR_ID)
    .map((d) => ({
      device: d,
      key: safe(() => d.handle) || `${safe(() => d.bus, "?")}-${safe(() => d.address, "?")}`,
      productId: d.productId,
      name: safe(() => d.productName) || "Kindle",
      serial: safe(() => d.serialNumber),
      mtp: findMtpInterface(d),
      massStorage: hasMassStorage(d)
    }));
}

/**
 * Run a USB step that needs access to the Kindle (opening it, claiming its
 * interface). On macOS, if the camera daemon holds the device, stop it and retry
 * before launchd brings it back; if another app holds it, say which one.
 */
async function acquire(step, label, { log, releaseCameraDaemon }) {
  let lastError;
  try {
    await step();
    return;
  } catch (e) {
    lastError = e;
  }
  log(`Could not ${label}: ${lastError?.message || lastError}`);

  if (process.platform !== "darwin") {
    if (/permission|access denied|not permitted/i.test(String(lastError?.message))) {
      throw new KindleAccessError("No permission to access the Kindle over USB.", {
        hint: 'Allow USB access with a udev rule, e.g. SUBSYSTEM=="usb", ATTR{idVendor}=="1949", MODE="0666".',
        cause: lastError
      });
    }
    throw new KindleAccessError("Another program is using the Kindle.", {
      hint: "Close file managers or apps that opened the Kindle (e.g. the desktop's MTP integration, calibre) and try again.",
      cause: lastError
    });
  }

  const owners = (await findUsbExclusiveOwners(KINDLE_VENDOR_ID).catch(() => [])).filter((o) => o.pid !== process.pid);
  if (owners.length) log(`IORegistry says the Kindle is held by: ${owners.map((o) => o.raw).join("; ")}`);
  const otherOwners = owners.filter((o) => !isCameraDaemon(o.name));
  if (otherOwners.length) {
    throw new KindleAccessError(`The Kindle is in use by ${otherOwners.map((o) => o.name).join(", ")}.`, {
      hint: "Quit that app (for Android File Transfer also quit its menu-bar agent) and click Import again.",
      cause: lastError
    });
  }

  if (releaseCameraDaemon) {
    for (let attempt = 1; attempt <= 15; attempt++) {
      const stopped = await stopCameraDaemons();
      if (stopped.length && attempt === 1) log(`Stopped ${stopped.join(", ")} (macOS camera import service) to free the Kindle.`);
      await new Promise((r) => setTimeout(r, attempt === 1 ? 50 : 150));
      try {
        await step();
        log(`Succeeded to ${label} after ${attempt} attempt(s).`);
        return;
      } catch (e) {
        lastError = e;
      }
    }
  }

  const apps = await runningMtpApps().catch(() => []);
  throw new KindleAccessError("macOS would not let this app talk to the Kindle.", {
    hint: apps.length
      ? `These apps can hold the Kindle: ${apps.join(", ")}. Quit them, unplug and replug the Kindle, then click Import.`
      : releaseCameraDaemon
        ? "Unplug and replug the Kindle, then click Import again. If it keeps failing, run `sudo killall -9 ptpcamerad` in Terminal and click Import right after."
        : "Turn on “Free the Kindle from the macOS camera service” in Settings, or run `killall -9 ptpcamerad` in Terminal, then click Import.",
    cause: lastError
  });
}

/**
 * Open an MTP session with the Kindle and download system/vocabulary/vocab.db.
 * @returns {Promise<{bytes:Buffer, deviceInfo:object|null, storage:string}>}
 */
export async function downloadVocabOverUsb(entry, { log = () => {}, onProgress, releaseCameraDaemon = true } = {}) {
  const { device, mtp } = entry;
  if (!mtp) {
    throw new KindleAccessError("This Kindle is connected as a USB drive, not over MTP.", {
      hint: "Wait for it to appear as a drive, then click Scan."
    });
  }

  const access = { log, releaseCameraDaemon };
  await acquire(() => device.open(), "open the Kindle's USB device", access);
  try {
    if (!safe(() => device.configuration)) await device.selectConfiguration(1);
    await acquire(() => device.claimInterface(mtp.interfaceNumber), "claim the Kindle's MTP interface", access);
    try {
      if (mtp.alternateSetting) await device.selectAlternateInterface(mtp.interfaceNumber, mtp.alternateSetting);
      const session = new MtpSession(new UsbBulkTransport(device, mtp), { log });

      let deviceInfo = null;
      try {
        deviceInfo = await session.getDeviceInfo();
        log(`Connected to ${deviceInfo.manufacturer} ${deviceInfo.model} (version ${deviceInfo.deviceVersion}).`);
      } catch (e) {
        log(`GetDeviceInfo failed (continuing): ${e.message}`);
      }

      await session.openSession();
      try {
        const storageIds = await session.getStorageIds();
        if (!storageIds.length) {
          throw new KindleAccessError("The Kindle did not report any storage.", {
            hint: "Wake the Kindle up (unlock the screen) and click Import again."
          });
        }
        const misses = [];
        for (const sid of storageIds) {
          let label = `storage 0x${sid.toString(16)}`;
          try {
            const si = await session.getStorageInfo(sid);
            label = si.description || si.volumeLabel || label;
          } catch {
            // the label is cosmetic
          }
          const { found, missing } = await session.findPath(sid, VOCAB_PATH);
          if (!found) {
            misses.push(`${label}: "${missing}" not found`);
            log(`${label}: ${missing} not found.`);
            continue;
          }
          log(`Found ${VOCAB_PATH.join("/")} on ${label} (${found.size} bytes). Downloading…`);
          const bytes = await session.getObject(found.handle, { onProgress });
          if (found.size && found.size !== 0xffffffff && bytes.length !== found.size) {
            log(`warn: expected ${found.size} bytes but received ${bytes.length}.`);
          }
          return { bytes, deviceInfo, storage: label };
        }
        throw new KindleAccessError("vocab.db is not visible over USB on this Kindle.", {
          hint:
            `Checked ${misses.join("; ")}. Make sure Vocabulary Builder is on and you have looked up at least one word. ` +
            "Some newer Kindle models hide the system folder over USB."
        });
      } finally {
        await session.closeSession().catch((e) => log(`CloseSession failed: ${e.message}`));
      }
    } finally {
      await device.releaseInterface(mtp.interfaceNumber).catch(() => {});
    }
  } finally {
    await device.close().catch(() => {});
  }
}
