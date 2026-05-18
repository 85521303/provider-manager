const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const sidecarDir = path.resolve(root, process.env.CPM_EXE_OUT_DIR || path.join("dist", "sidecar"));

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

function hostTriple() {
  try {
    const output = execFileSync("rustc", ["-vV"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    const host = output.split(/\r?\n/)
      .map((line) => line.match(/^host:\s*(.+)$/))
      .find(Boolean);
    if (host) return host[1].trim();
  } catch {
    // Tauri build will fail later with a clear Rust toolchain error.
  }

  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";

  throw new Error(`Unsupported platform for Tauri sidecar naming: ${process.platform}/${process.arch}`);
}

function sidecarSource() {
  const name = process.platform === "win32" ? "ProviderManager.exe" : "provider-manager";
  return path.join(sidecarDir, name);
}

function sidecarBuildEnv() {
  return {
    ...process.env,
    CPM_EXE_OUT_DIR: path.dirname(sidecarSource()),
  };
}

function ensureSidecarSource() {
  const source = sidecarSource();
  run(process.execPath, ["build-exe.js"], { env: sidecarBuildEnv() });
  if (!fs.existsSync(source)) throw new Error(`Sidecar executable was not built: ${source}`);
  return source;
}

function main() {
  const source = ensureSidecarSource();
  const triple = hostTriple();
  const extension = process.platform === "win32" ? ".exe" : "";
  const destination = path.join(sidecarDir, `provider-manager-${triple}${extension}`);

  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.copyFileSync(source, destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
  console.log(`Prepared Tauri sidecar: ${destination}`);
}

main();
