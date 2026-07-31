import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const root = process.cwd();
const build = process.env.GITHUB_RUN_NUMBER || process.env.BUILD_NUMBER || (() => {
  try { return String(execSync("git rev-list --count HEAD")).trim(); } catch { return "1"; }
})();
const version = `1.0.0-v${build}`;
const out = path.join(root, "dist", `IslandAddon-${version}`);
const zip = path.join(root, "dist", `IslandAddon-${version}.mcaddon`);
const packUuid = crypto.randomUUID();
const scriptUuid = crypto.randomUUID();

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
fs.mkdirSync(path.join(out, "behavior_pack", "scripts"), { recursive: true });

const manifest = {
  format_version: 2,
  header: {
    name: `IslandAddon ${version}`,
    description: "Carves a large piece of existing terrain into a natural inverted-teardrop island.",
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
  fs.copyFileSync(path.join(root, "behavior_pack", "scripts", file), path.join(out, "behavior_pack", "scripts", file));
}
fs.writeFileSync(path.join(out, "README.txt"), `IslandAddon ${version}\n\nBuild: ${build}\nPack UUID: ${packUuid}\nScript UUID: ${scriptUuid}\n\nThe generator captures a large existing terrain region before mutation, then carves and reconstructs a natural inverted-teardrop island from the captured material.\n`);

const archiver = (await import("archiver")).default;
const output = fs.createWriteStream(zip);
const archive = archiver("zip", { zlib: { level: 9 } });
archive.pipe(output);
archive.directory(path.join(out, "behavior_pack"), "behavior_pack");
archive.file(path.join(out, "README.txt"), { name: "README.txt" });
await archive.finalize();
await new Promise((resolve, reject) => { output.on("close", resolve); output.on("error", reject); });
console.log(`Built ${zip}`);
