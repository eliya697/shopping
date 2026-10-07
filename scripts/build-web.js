/*
 * Copies the frontend into www/, the folder Capacitor bundles into the Android app
 * (capacitor.config.json -> webDir). The site has no build step, so this is a plain
 * copy of the same files GitHub Pages serves, minus the developer-only admin page.
 *
 *   npm run build:web      (npm run cap:sync also runs this)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "www");

const FILES = [
  "index.html",
  "style.css",
  "manifest.json",
  "icon.svg",
  "config.js",
  "categories.js",
  "item-parser.js",
  "quick-add.js",
  "voice.js",
  "ai-chat.js",
  "fridge-vision.js",
  "socket-client.js",
  "pwa-update.js",
  "sw.js",
  "app.js",
  "vendor/socket.io.min.js",
];

fs.rmSync(OUT, { recursive: true, force: true });
for (const file of FILES) {
  const from = path.join(ROOT, file);
  if (!fs.existsSync(from)) throw new Error(`build-web: missing ${file}`);
  const to = path.join(OUT, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// Every <script src> in index.html must be bundled, or the app breaks only on Android.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const missing = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((src) => !FILES.includes(src));
if (missing.length) throw new Error(`build-web: index.html loads files not in FILES: ${missing.join(", ")}`);

console.log(`build-web: copied ${FILES.length} files to www/`);
