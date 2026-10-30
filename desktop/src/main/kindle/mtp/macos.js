// macOS specifics for raw-USB MTP access.
//
// macOS has no MTP support of its own, but its camera import daemon
// (ptpcamerad, PTPCamera on older systems) grabs PTP/MTP devices as soon as they
// are plugged in. While it holds the Kindle's interface nobody else can claim it,
// which is why Amazon ships its own USB helper. launchd restarts the daemon on
// demand, so stopping it right before we claim the interface is safe.

import { execFile } from "node:child_process";

const CAMERA_DAEMONS = ["ptpcamerad", "PTPCamera"];

const KNOWN_MTP_APPS = [
  { match: /Android File Transfer/i, label: "Android File Transfer" },
  { match: /OpenMTP/i, label: "OpenMTP" },
  { match: /Send to Kindle/i, label: "Amazon Send to Kindle" },
  { match: /MacDroid/i, label: "MacDroid" },
  { match: /calibre/i, label: "calibre" },
  { match: /Commander One/i, label: "Commander One" }
];

function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || "") });
    });
  });
}

export const isCameraDaemon = (name = "") => CAMERA_DAEMONS.some((d) => name.includes(d));

/**
 * Which processes hold the USB device/interfaces of the given vendor, according
 * to the IORegistry "UsbExclusiveOwner" property (e.g. "pid 512, ptpcamerad").
 */
export async function findUsbExclusiveOwners(vendorId) {
  const owners = new Map();
  for (const cls of ["IOUSBHostInterface", "IOUSBHostDevice"]) {
    const { stdout } = await run("/usr/sbin/ioreg", ["-r", "-c", cls, "-l", "-w0"]);
    for (const block of stdout.split(/\n(?=[\s|]*\+-o )/)) {
      if (!new RegExp(`"idVendor"\\s*=\\s*${vendorId}\\b`).test(block)) continue;
      for (const m of block.matchAll(/"UsbExclusiveOwner"\s*=\s*"([^"]*)"/g)) {
        const raw = m[1];
        const pm = raw.match(/pid\s*(\d+)\s*,\s*(.+)/i);
        owners.set(raw, pm ? { pid: Number(pm[1]), name: pm[2].trim(), raw } : { pid: null, name: raw, raw });
      }
    }
  }
  return [...owners.values()];
}

/** Stop the camera import daemon(s). Returns the names that were running. */
export async function stopCameraDaemons() {
  const stopped = [];
  for (const name of CAMERA_DAEMONS) {
    const { code } = await run("/usr/bin/pkill", ["-9", "-x", name]);
    if (code === 0) stopped.push(name);
  }
  return stopped;
}

/** Other MTP clients that are running and may be holding the Kindle. */
export async function runningMtpApps() {
  const { stdout } = await run("/bin/ps", ["-axo", "comm="]);
  const found = new Set();
  for (const line of stdout.split("\n")) {
    for (const app of KNOWN_MTP_APPS) if (app.match.test(line)) found.add(app.label);
  }
  return [...found];
}
