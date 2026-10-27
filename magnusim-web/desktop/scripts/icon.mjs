// Draws Magnusim CAD's icon (D2: the Part cube of the CAD plugin's manifest, in Magnusim's blue)
// to a 512 px PNG with Electron's own renderer; electron-builder makes the .ico from it.
//   electron scripts/icon.mjs <out.png>
// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = process.argv[process.argv.length - 1];
const manifest = readFileSync(join(HERE, '..', '..', 'bundled-plugins', 'cad', 'manifest.toml'), 'utf8');
const cube = /^\[\[workspaces\]\][\s\S]*?^icon\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
if (!cube) throw new Error("the CAD manifest's workspace has no icon");

const SIZE = 512;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">
  <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5" fill="#1570ef"/>
  <g transform="translate(2.4 2.4) scale(0.8)"><path d="${cube}" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></g>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  app.exit(0);
});
