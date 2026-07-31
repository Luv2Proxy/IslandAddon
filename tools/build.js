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

const manifest = JSON.parse(fs.readFileSync(path.join(root, "behavior_pack", "manifest.json"), "utf8"));
manifest.header.name = `IslandAddon ${version}`;
manifest.header.uuid = packUuid;
manifest.header.version = [1, 0, Number(build) || 0];
manifest.modules[0].uuid = scriptUuid;
manifest.modules[0].version = [1, 0, Number(build) || 0];
fs.writeFileSync(path.join(out, "behavior_pack", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.copyFileSync(path.join(root, "behavior_pack", "scripts", "main.js"), path.join(out, "behavior_pack", "scripts", "main.js"));

fs.writeFileSync(path.join(out, "README.txt"), `IslandAddon ${version}\n\nGenerated build: ${build}\nPack UUID: ${packUuid}\nScript UUID: ${scriptUuid}\n\nInstall the .mcaddon file into Minecraft Bedrock.\n`);

const archiver = (await import("archiver")).default;
const output = fs.createWriteStream(zip);
const archive = archiver("zip", { zlib: { level: 9 } });
archive.pipe(output);
archive.directory(path.join(out, "behavior_pack"), "behavior_pack");
archive.file(path.join(out, "README.txt"), { name: "README.txt" });
await archive.finalize();
await new Promise((resolve, reject) => { output.on("close", resolve); output.on("error", reject); });
console.log(`Built ${zip}`);
