import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["v2-local", "v2-public", "classic"].includes(mode))
  throw Error("Select v2-local, v2-public or classic");
const root = fileURLToPath(new URL("../", import.meta.url));
const env = {
  ...process.env,
  WEB_EXPERIENCE: mode === "classic" ? "classic" : "living-town",
  LIVING_TOWN_TARGET: mode.slice(3),
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Reuse the pinned pnpm that launched this script, without a shell on Windows.
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli || !/pnpm/i.test(pnpmCli))
  throw Error(
    "Run through corepack pnpm build:demo, build:demo:public or build:web:classic",
  );
run(process.execPath, [pnpmCli, "build:packages"]);
run(process.execPath, [pnpmCli, "--filter", "@bot-bazaar/web", "build"]);
run(process.execPath, [
  "scripts/check-web-output.mjs",
  "apps/web/dist/browser",
  mode,
]);
