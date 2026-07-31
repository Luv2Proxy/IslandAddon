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
const staging = path.join(dist, `IslandAddon-${version}`);
const pack = path.join(staging, "IslandAddon_BP");
const zip = path.join(dist, `IslandAddon-${version}.mcpack`);
const packUuid = crypto.randomUUID();
const scriptUuid = crypto.randomUUID();

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(pack, "scripts"), { recursive: true });

const manifest = {
  format_version: 2,
  header: {
    name: `IslandAddon ${version}`,
    description: "Procedurally carves existing Minecraft terrain into a seeded natural sky-world archipelago.",
    min_engine_version: [1, 21, 0],
    uuid: packUuid,
    version: [1, 0, Number(build) || 0],
    // Bedrock looks for this image at the root of the behavior pack.
    // The build copies it into the pack and the manifest references it here.
    icon: "pack_icon.png"
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

fs.writeFileSync(path.join(pack, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const file of ["main.js", "terrain.js"]) {
  const source = path.join(root, "behavior_pack", "scripts", file);
  if (!fs.existsSync(source)) throw new Error(`Missing required script: ${source}`);
  fs.copyFileSync(source, path.join(pack, "scripts", file));
}

const iconSource = path.join(root, "behavior_pack", "pack_icon.png");
const iconTarget = path.join(pack, "pack_icon.png");
if (!fs.existsSync(iconSource)) {
  throw new Error(`Missing required pack icon: ${iconSource}`);
}
fs.copyFileSync(iconSource, iconTarget);

fs.writeFileSync(path.join(pack, "README.txt"), `IslandAddon ${version}\nBuild: ${build}\nPack UUID: ${packUuid}\nScript UUID: ${scriptUuid}\n`);

// A .mcpack is itself a ZIP. Its ROOT must contain manifest.json, scripts/, and pack_icon.png.
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(zip);
  const archive = archiver("zip", { zlib: { level: 9 } });
  let settled = false;
  const fail = error => { if (!settled) { settled = true; reject(error); } };
  output.on("close", () => { if (!settled) { settled = true; resolve(); } });
  output.on("error", fail);
  archive.on("error", fail);
  archive.pipe(output);
  archive.directory(pack, false);
  archive.finalize().catch(fail);
});

const signature = fs.readFileSync(zip).subarray(0, 4);
if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
  throw new Error(`Generated artifact is not a ZIP archive: ${zip}`);
}
console.log(`Built valid Minecraft behavior pack: ${zip} (${fs.statSync(zip).size} bytes)`);
