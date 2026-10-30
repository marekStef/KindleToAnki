// Renders build/icon.png (1024×1024) from the SVG below with Electron itself.
// electron-builder turns it into the .ico/.icns icons. Run: npm run icon

import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#1e1b4b"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#020617" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#bg)"/>
  <g filter="url(#shadow)" transform="rotate(-8 430 500)">
    <rect x="262" y="214" width="340" height="490" rx="46" fill="#f8fafc"/>
    <rect x="298" y="258" width="268" height="356" rx="12" fill="#e2e8f0"/>
    <g stroke="#94a3b8" stroke-width="18" stroke-linecap="round">
      <line x1="336" y1="316" x2="528" y2="316"/>
      <line x1="336" y1="368" x2="528" y2="368"/>
      <line x1="336" y1="420" x2="470" y2="420"/>
      <line x1="336" y1="472" x2="512" y2="472"/>
      <line x1="336" y1="524" x2="440" y2="524"/>
    </g>
    <circle cx="432" cy="660" r="17" fill="#cbd5e1"/>
  </g>
  <g filter="url(#shadow)" transform="rotate(9 650 610)">
    <rect x="492" y="438" width="320" height="372" rx="38" fill="#ffffff"/>
    <path d="M572 630 l58 58 l112 -124" fill="none" stroke="#22c55e" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const out = path.join(import.meta.dirname, "..", "build", "icon.png");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true }
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: "best" });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`wrote ${out} (${image.getSize().width}×${image.getSize().height})`);
  app.quit();
});
