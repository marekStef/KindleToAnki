// Windows: talk to Kindles through the Windows Shell (see kindle-shell.ps1).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SCRIPT_PATH = path.join(import.meta.dirname, "kindle-shell.ps1");
let scriptCache = null;

function powershellExe() {
  const root = process.env.SystemRoot || "C:\\Windows";
  const builtIn = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(builtIn) ? builtIn : "powershell.exe";
}

/** Run kindle-shell.ps1 with the given KTA_* environment and return its JSON result. */
export function runShellScript(env, { timeoutMs = 60_000 } = {}) {
  scriptCache ??= fs.readFileSync(SCRIPT_PATH, "utf8");
  // -EncodedCommand is not subject to the execution policy (unlike -File).
  const encoded = Buffer.from(scriptCache, "utf16le").toString("base64");
  if (encoded.length > 32_000) throw new Error("kindle-shell.ps1 is too large for -EncodedCommand (Windows command-line limit).");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];

  return new Promise((resolve, reject) => {
    const child = spawn(powershellExe(), args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows did not answer in time while talking to the Kindle."));
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start PowerShell: ${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith("KTA_JSON:"));
      if (!line) {
        reject(new Error(`Unexpected PowerShell output: ${(stderr || stdout).trim().slice(0, 500) || "(empty)"}`));
        return;
      }
      let result;
      try {
        result = JSON.parse(line.slice("KTA_JSON:".length).replace(/^\uFEFF/, ""));
      } catch (e) {
        reject(new Error(`Could not parse PowerShell output: ${e.message}`));
        return;
      }
      if (!result.ok) reject(new Error(result.error || "PowerShell reported an error."));
      else resolve(result);
    });
  });
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** List Kindles: MTP devices (via the Shell) and Kindles mounted as drives. */
export async function scanWindows() {
  const res = await runShellScript({ KTA_MODE: "scan" });
  return {
    devices: asArray(res.devices).map((d) => ({ ...d, storages: asArray(d.storages) })),
    drives: asArray(res.drives)
  };
}

/** Copy vocab.db from an MTP Kindle into destDir; resolves to the copied file path. */
export async function copyVocabFromDevice({ deviceId, storageName, destDir }) {
  const res = await runShellScript(
    { KTA_MODE: "copy", KTA_DEVICE_ID: deviceId, KTA_STORAGE: storageName || "", KTA_DEST: destDir, KTA_TIMEOUT_SEC: "120" },
    { timeoutMs: 150_000 }
  );
  return res.result;
}
