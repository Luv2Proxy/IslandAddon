import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const archiver = require("archiver");
const root = process.cwd();
const build = process.env.GITHUB_RUN_NUMBER || process.env.BUILD_NUMBER || (() => {
  try { return String(execSync("git rev-list --count HEAD")).trim(); } catch { return "1"; }
})();
const version = `1.0.0-v${build}`;
const dist = path.join(root, "dist");
const out = path.join(dist, `IslandAddon-${version}`);
const zip = path.join(dist, `IslandAddon-${version}.mcaddon`);
const packUuid = crypto.randomUUID();
const scriptUuid = crypto.randomUUID();

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "behavior_pack", "scripts"), { recursive: true });

const manifest = {
  format_version: 2,
  header: {
    name: `IslandAddon ${version}`,
    description: "Procedurally carves existing Minecraft terrain into a seeded natural sky-world archipelago.",
    min_engine_version: [1, 21, 0],
    uuid: packUuid,
    version: [1, 0, Number(build) || 0]
  },
  modules: [{
    description: "IslandAddon Script",
    type: "script",
    language: "javascript",
    uuid: scriptUuid,
    entry: "scripts/main.js",
    version: [1, 0, Number(build) || 0]
  }],
  dependencies: [{ module_name: "@minecraft/server", version: "2.0.0" }]
};

fs.writeFileSync(path.join(out, "behavior_pack", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const file of ["main.js", "terrain.js"]) {
  const source = path.join(root, "behavior_pack", "scripts", file);
  if (!fs.existsSync(source)) throw new Error(`Missing required script: ${source}`);
  fs.copyFileSync(source, path.join(out, "behavior_pack", "scripts", file));
}
fs.writeFileSync(path.join(out, "README.txt"), `IslandAddon ${version}\n\nBuild: ${build}\nPack UUID: ${packUuid}\nScript UUID: ${scriptUuid}\n\nProcedural sky-world archipelago generator.\n`);

await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(zip);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(path.join(out, "behavior_pack"), "behavior_pack");
  archive.file(path.join(out, "README.txt"), { name: "README.txt" });
  archive.finalize().catch(reject);
});

const signature = fs.readFileSync(zip).subarray(0, 4);
if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
  throw new Error(`Generated artifact is not a ZIP archive: ${zip}`);
}
console.log(`Built valid Minecraft addon: ${zip} (${fs.statSync(zip).size} bytes)`);
