const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = __dirname;
const dist = path.join(root, "dist");
const blobPath = path.join(dist, "codex-provider-manager.blob");
const exePath = path.join(dist, "CodexProviderManager.exe");
const seaConfigPath = path.join(dist, "sea-config.json");
const vendorDir = path.join(dist, "vendor");

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[\s&()^|<>"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function runNpx(args) {
  if (process.platform !== "win32") {
    run("npx", args);
    return;
  }

  const command = ["call", "npx.cmd", ...args.map(quoteCmdArg)].join(" ");
  console.log(`> ${command}`);
  execFileSync("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: root,
    stdio: "inherit",
  });
}

function patchWindowsSubsystem(executablePath) {
  const buffer = fs.readFileSync(executablePath);
  const peOffset = buffer.readUInt32LE(0x3c);
  const signature = buffer.toString("ascii", peOffset, peOffset + 4);
  if (signature !== "PE\u0000\u0000") {
    throw new Error("The generated file is not a PE executable.");
  }

  const optionalHeaderOffset = peOffset + 4 + 20;
  const subsystemOffset = optionalHeaderOffset + 68;
  const currentSubsystem = buffer.readUInt16LE(subsystemOffset);
  const windowsGuiSubsystem = 2;

  if (currentSubsystem !== windowsGuiSubsystem) {
    buffer.writeUInt16LE(windowsGuiSubsystem, subsystemOffset);
    fs.writeFileSync(executablePath, buffer);
  }
}

function firstCommandPath(command) {
  try {
    const output = execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], {
      encoding: "utf8",
      windowsHide: true,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function addSqliteAssets(assets) {
  const sqliteExe = process.env.SQLITE3_PATH || firstCommandPath(process.platform === "win32" ? "sqlite3.exe" : "sqlite3");
  if (!sqliteExe || !fs.existsSync(sqliteExe)) {
    console.warn("sqlite3 was not found on PATH; the exe will use system sqlite3 if available at runtime.");
    return;
  }

  fs.mkdirSync(vendorDir, { recursive: true });
  const copiedExe = path.join(vendorDir, "sqlite3.exe");
  fs.copyFileSync(sqliteExe, copiedExe);
  assets["vendor/sqlite3.exe"] = path.relative(root, copiedExe).replace(/\\/g, "/");

  const sqliteDll = path.join(path.dirname(sqliteExe), "sqlite3.dll");
  if (fs.existsSync(sqliteDll)) {
    const copiedDll = path.join(vendorDir, "sqlite3.dll");
    fs.copyFileSync(sqliteDll, copiedDll);
    assets["vendor/sqlite3.dll"] = path.relative(root, copiedDll).replace(/\\/g, "/");
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const assets = {
  "public/index.html": "public/index.html",
  "public/app.js": "public/app.js",
  "public/styles.css": "public/styles.css",
};
addSqliteAssets(assets);

const seaConfig = {
  main: "server.js",
  output: path.relative(root, blobPath).replace(/\\/g, "/"),
  disableExperimentalSEAWarning: true,
  assets,
};

fs.writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`, "utf8");
run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

fs.copyFileSync(process.execPath, exePath);

runNpx([
  "--yes",
  "postject",
  exePath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
]);

patchWindowsSubsystem(exePath);
fs.rmSync(blobPath, { force: true });
fs.rmSync(seaConfigPath, { force: true });
fs.rmSync(vendorDir, { recursive: true, force: true });

console.log("");
console.log(`Built ${exePath}`);
console.log("Double-click the exe to open Codex Provider Manager.");
