const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "darwin") {
  console.log("Skipping macOS command interceptor build on", process.platform);
  process.exit(0);
}

const root = path.resolve(__dirname, "../..");
const nodeGyp = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "node-gyp.cmd" : "node-gyp"
);
const nodeRoot = path.resolve(path.dirname(process.execPath), "..");

const xcodePython = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
const env = { ...process.env };
if (!env.PYTHON && fs.existsSync(xcodePython)) env.PYTHON = xcodePython;

const result = spawnSync(
  nodeGyp,
  ["rebuild", "--directory", __dirname, `--nodedir=${nodeRoot}`],
  { cwd: root, stdio: "inherit", env }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
