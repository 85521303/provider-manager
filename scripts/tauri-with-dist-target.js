const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const env = {
  ...process.env,
  CARGO_TARGET_DIR: path.join(root, "dist", "tauri-target"),
  CPM_EXE_OUT_DIR: path.join(root, "dist", "sidecar"),
};

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(process.execPath, ["scripts/prepare-tauri-sidecar.js"]);
run(process.platform === "win32" ? "npx.cmd" : "npx", ["tauri", ...args]);
