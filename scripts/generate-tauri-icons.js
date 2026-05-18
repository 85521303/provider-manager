const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const root = path.resolve(__dirname, "..");
const iconDir = path.join(root, "src-tauri", "icons");
const publicDir = path.join(root, "public");
const assetDir = path.join(publicDir, "assets");
const faviconSource = path.join(assetDir, "app-favicon-source.png");
const appIconSource = path.join(assetDir, "app-icon-source.png");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadPng(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing icon source: ${filePath}`);
  }
  return PNG.sync.read(fs.readFileSync(filePath));
}

function resizePng(source, size) {
  const target = new PNG({ width: size, height: size, colorType: 6 });
  const xRatio = source.width / size;
  const yRatio = source.height / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x + 0.5) * xRatio));
      const sy = Math.min(source.height - 1, Math.floor((y + 0.5) * yRatio));
      const sourceIndex = (source.width * sy + sx) << 2;
      const targetIndex = (size * y + x) << 2;
      target.data[targetIndex] = source.data[sourceIndex];
      target.data[targetIndex + 1] = source.data[sourceIndex + 1];
      target.data[targetIndex + 2] = source.data[sourceIndex + 2];
      target.data[targetIndex + 3] = source.data[sourceIndex + 3];
    }
  }

  return PNG.sync.write(target);
}

function makeIco(pngBuffer) {
  const pngSize = pngBuffer.length;
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngSize, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuffer]);
}

function makeIcns(pngBuffer) {
  const type = Buffer.from("icns");
  const pngType = Buffer.from("ic08");
  const entryLen = Buffer.alloc(4);
  entryLen.writeUInt32BE(pngBuffer.length + 8, 0);
  const total = Buffer.alloc(4);
  total.writeUInt32BE(pngBuffer.length + 12, 0);
  return Buffer.concat([type, total, pngType, entryLen, pngBuffer]);
}

ensureDir(iconDir);
ensureDir(publicDir);
ensureDir(assetDir);

const favicon = loadPng(faviconSource);
const appIcon = loadPng(appIconSource);
const sizes = [32, 128, 256];

for (const size of sizes) {
  fs.writeFileSync(path.join(iconDir, `${size}x${size}.png`), resizePng(appIcon, size));
}

fs.writeFileSync(path.join(iconDir, "128x128@2x.png"), resizePng(appIcon, 256));
fs.writeFileSync(path.join(iconDir, "icon.ico"), makeIco(resizePng(appIcon, 256)));
fs.writeFileSync(path.join(iconDir, "icon.icns"), makeIcns(resizePng(appIcon, 256)));
fs.writeFileSync(path.join(iconDir, "source.png"), resizePng(appIcon, 1024));
fs.writeFileSync(path.join(publicDir, "favicon.png"), resizePng(favicon, 256));
fs.writeFileSync(path.join(publicDir, "favicon.ico"), makeIco(resizePng(favicon, 256)));

console.log(`Generated Tauri icons in ${iconDir}`);
console.log(`Generated favicon files in ${publicDir}`);
