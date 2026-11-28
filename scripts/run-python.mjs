import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const configured = process.env.BOOKWORM_PYTHON?.trim();
const projectPython = resolve(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const candidates = configured
  ? [[configured]]
  : process.platform === "win32"
    ? [[projectPython], ["py"], ["python"], ["python3"]]
    : [[projectPython], ["python3"], ["python"]];

for (const [command] of candidates) {
  if (command === projectPython && !existsSync(command)) continue;
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) continue;
  const result = spawnSync(command, process.argv.slice(2), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

console.error("Python was not found. Install Python 3 or set BOOKWORM_PYTHON to its executable path.");
process.exit(127);
