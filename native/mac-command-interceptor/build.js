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

const XCODE_PYTHON = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";
const COMMAND_LINE_TOOLS_DIR = "/Library/Developer/CommandLineTools";
const CLT_PYTHON = path.join(COMMAND_LINE_TOOLS_DIR, "usr", "bin", "python3");

/**
 * 未接受 Xcode 许可时，make/clang 会以 exit 69 + 许可提示失败，
 * 但 `xcodebuild -version` 仍返回 0，所以用 xcrun 探测才准确。
 */
function isXcodeToolchainUsable() {
  try {
    const probe = spawnSync("/usr/bin/xcrun", ["--find", "clang"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** 选一个真正可用的 python3（Xcode 自带的在许可未接受时不可用） */
function resolvePython() {
  const candidates = [
    process.env.PYTHON,
    isXcodeToolchainUsable() ? XCODE_PYTHON : undefined,
    CLT_PYTHON,
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "python3"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version_info[0])"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (probe.status === 0) return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }

  return undefined;
}

const env = { ...process.env };
const python = resolvePython();
if (python) env.PYTHON = python;

if (!env.DEVELOPER_DIR && fs.existsSync(COMMAND_LINE_TOOLS_DIR) && !isXcodeToolchainUsable()) {
  env.DEVELOPER_DIR = COMMAND_LINE_TOOLS_DIR;
  console.warn(
    "[build] 检测到 Xcode 许可未接受，改用 Command Line Tools 编译原生模块：",
    COMMAND_LINE_TOOLS_DIR
  );
}

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
