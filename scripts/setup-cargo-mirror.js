const fs = require("fs");
const os = require("os");
const path = require("path");

if (/^(1|true|yes)$/i.test(process.env.CPM_SKIP_CARGO_MIRROR || "")) {
  console.log("Skipped cargo mirror config because CPM_SKIP_CARGO_MIRROR is set.");
  process.exit(0);
}

const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
const configPath = path.join(cargoHome, "config.toml");

fs.mkdirSync(cargoHome, { recursive: true });
fs.writeFileSync(
  configPath,
  [
    "[registries.crates-io]",
    'protocol = "sparse"',
    "",
    '[source.crates-io]',
    'replace-with = "rsproxy"',
    "",
    '[source.rsproxy]',
    'registry = "sparse+https://rsproxy.cn/index/"',
    "",
  ].join("\n"),
  "utf8"
);

console.log(`Wrote cargo mirror config to ${configPath}`);
