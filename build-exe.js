const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = __dirname;
const dist = path.resolve(root, process.env.CPM_EXE_OUT_DIR || path.join("dist", "sidecar"));
const blobPath = path.join(dist, "provider-manager.blob");
const executableName = process.platform === "win32" ? "ProviderManager.exe" : "provider-manager";
const exePath = path.join(dist, executableName);
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
  if (process.platform !== "win32") return;
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

function findWindowsSignatureTool() {
  if (process.platform !== "win32") return null;

  const direct = firstCommandPath("signtool.exe");
  if (direct) return direct;

  const kitsRoot = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  try {
    return fs.readdirSync(kitsRoot)
      .map((version) => path.join(kitsRoot, version, "x64", "signtool.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
      .pop() || null;
  } catch {
    return null;
  }
}

function removeWindowsSignature(executablePath) {
  if (process.platform !== "win32") return;

  const signtool = findWindowsSignatureTool();
  if (!signtool) {
    console.warn("signtool.exe was not found; continuing without removing the Windows signature.");
    return;
  }

  run(signtool, ["remove", "/s", executablePath]);
}

function removeDarwinSignature(executablePath) {
  if (process.platform !== "darwin") return;
  run("codesign", ["--remove-signature", executablePath]);
}

function signDarwinAdHoc(executablePath) {
  if (process.platform !== "darwin") return;
  run("codesign", ["--sign", "-", executablePath]);
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
    console.warn("sqlite3 was not found on PATH; the executable will use system sqlite3 if available at runtime.");
    return;
  }

  fs.mkdirSync(vendorDir, { recursive: true });
  const copiedName = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
  const copiedExe = path.join(vendorDir, copiedName);
  fs.copyFileSync(sqliteExe, copiedExe);
  assets[`vendor/${copiedName}`] = path.relative(root, copiedExe).replace(/\\/g, "/");

  const sqliteDll = process.platform === "win32" ? path.join(path.dirname(sqliteExe), "sqlite3.dll") : "";
  if (sqliteDll && fs.existsSync(sqliteDll)) {
    const copiedDll = path.join(vendorDir, "sqlite3.dll");
    fs.copyFileSync(sqliteDll, copiedDll);
    assets["vendor/sqlite3.dll"] = path.relative(root, copiedDll).replace(/\\/g, "/");
  }
}

function collectFilesRecursively(baseDir, prefix) {
  const assets = {};
  if (!fs.existsSync(baseDir)) return assets;

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(baseDir, absolutePath).replace(/\\/g, "/");
      assets[`${prefix}/${relativePath}`] = path.relative(root, absolutePath).replace(/\\/g, "/");
    }
  }

  walk(baseDir);
  return assets;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const assets = {
  ...collectFilesRecursively(path.join(root, "public"), "public"),
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
removeWindowsSignature(exePath);
removeDarwinSignature(exePath);

const postjectArgs = [
  "--yes",
  "postject",
  exePath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];

if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}

runNpx(postjectArgs);

patchWindowsSubsystem(exePath);
signDarwinAdHoc(exePath);
if (process.platform !== "win32") fs.chmodSync(exePath, 0o755);
fs.rmSync(blobPath, { force: true });
fs.rmSync(seaConfigPath, { force: true });
fs.rmSync(vendorDir, { recursive: true, force: true });

console.log("");
console.log(`Built ${exePath}`);
console.log("Run the executable to open ProviderManager.");
