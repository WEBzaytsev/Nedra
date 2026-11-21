import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--debug") throw new Error(`unknown option ${arg}`);
}
const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, "src-tauri");
const triple = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { cwd: crate }).toString())[1];
const debug = args.has("--debug") || process.env.TAURI_ENV_DEBUG === "true";
const profile = debug ? "debug" : "release";
const cargo = ["build", "-p", "nedra-native-host", "--locked"];
if (profile === "release") cargo.push("--release");

execFileSync("cargo", cargo, { cwd: crate, stdio: "inherit" });

const exe = triple.includes("windows") ? ".exe" : "";
const built = join(crate, "target", profile, `native-host${exe}`);
const target = join(crate, "binaries", `nedra-native-host-${triple}${exe}`);
mkdirSync(dirname(target), { recursive: true });
copyFileSync(built, `${target}.partial`);
renameSync(`${target}.partial`, target);
console.log(`native host (${profile}): ${target}`);