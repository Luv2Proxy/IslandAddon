import { world, system } from "@minecraft/server";
import { hash, noise, sourceAt } from "./terrain.js";

const CONFIG = {
  surfaceY: 120,
  sourceRadius: 40,
  islandRadius: 30,
  maxDepth: 42,
  minY: -64,
  maxY: 319,
  batch: 128,
  runProperty: "islandaddon_test_complete",
  seedProperty: "islandaddon_seed",
};

let started = false;
let busy = false;
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);

function isAir(id) { return AIR.has(id); }
function isWater(id) { return WATER.has(id); }
function isNaturalSurface(id) {
  return id.includes("grass") || id.includes("dirt") || id.includes("stone") || id.includes("sand") ||
    id.includes("gravel") || id.includes("clay") || id.includes("mud") || id.includes("snow") ||
    id.includes("podzol") || id.includes("mycelium") || id.includes("path") || id.includes("farmland") ||
    id.includes("netherrack") || id.includes("nylium") || id.includes("soul_sand") || id.includes("soul_soil") ||
    id.includes("deepslate");
}
function isDeepMaterial(id) {
  return id === "minecraft:stone" || id === "minecraft:deepslate" || id === "minecraft:tuff" ||
    id === "minecraft:granite" || id === "minecraft:diorite" || id === "minecraft:andesite" ||
    id === "minecraft:calcite" || id === "minecraft:dripstone_block";
}
function rng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0; return (x >>> 0) / 4294967296; };
}
function setBlock(d, x, y, z, p) { const b = d.getBlock({ x, y, z }); if (b) b.setPermutation(p); }

function playerChunkLoaded(d, cx, cz) {
  const probes = [[cx, cz], [cx + 8, cz], [cx - 8, cz], [cx, cz + 8], [cx, cz - 8],
    [cx + 15, cz + 15], [cx - 15, cz + 15], [cx + 15, cz - 15], [cx - 15, cz - 15]];
  let loaded = 0;
  for (const [x, z] of probes) {
    try { if (d.getBlock({ x, y: Math.floor(CONFIG.surfaceY), z })) loaded++; } catch {}
  }
  return { loaded, total: probes.length };
}

async function waitForPlayerArea(player) {
  const d = player.dimension, cx = Math.floor(player.location.x), cz = Math.floor(player.location.z);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const probe = playerChunkLoaded(d, cx, cz);
    player.sendMessage(`§7[IslandAddon] Loaded chunk probes: ${probe.loaded}/${probe.total} (attempt ${attempt}/10)`);
    if (probe.loaded >= 1) return true;
    await system.waitTicks(20);
  }
  return false;
}

function findTerrainSurface(d, x, z) {
  try { if (!d.getBlock({ x, y: Math.floor(CONFIG.surfaceY), z })) return null; } catch { return null; }
  for (let y = Math.min(CONFIG.maxY, CONFIG.surfaceY + 64); y >= CONFIG.minY; y--) {
    let b;
    try { b = d.getBlock({ x, y, z }); } catch { return null; }
    if (!b || isAir(b.typeId) || isWater(b.typeId)) continue;
    if (isNaturalSurface(b.typeId)) return y;
  }
  return null;
}

async function captureSource(d, cx, cz) {
  const source = new Map();
  let scanned = 0;
  const r = CONFIG.islandRadius;
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      const sx = cx + x, sz = cz + z, surfaceY = findTerrainSurface(d, sx, sz);
      if (surfaceY === null) continue;
      const blocks = [], deep = [];
      for (let y = surfaceY; y <= Math.min(CONFIG.maxY, surfaceY + 48); y++) {
        const b = d.getBlock({ x: sx, y, z: sz });
        if (b && !isAir(b.typeId)) blocks.push({ dy: y - surfaceY, permutation: b.permutation });
      }
      for (let y = surfaceY - 1; y >= Math.max(CONFIG.minY, surfaceY - 48); y--) {
        const b = d.getBlock({ x: sx, y, z: sz });
        if (b && !isAir(b.typeId) && !isWater(b.typeId) && isDeepMaterial(b.typeId)) deep.push(b.permutation);
      }
      source.set(`${x},${z}`, { surfaceY, blocks, deep });
      if (++scanned % 32 === 0) await system.waitTicks(1);
    }
  }
  return source;
}

function islandInside(dx, depth, dz, radius, seed) {
  const distance = Math.sqrt(dx * dx + dz * dz);
  const edge = noise(dx * 0.08, dz * 0.08, seed) * 3.5 + noise(dx * 0.025, dz * 0.025, seed ^ 0x71) * 5;
  if (distance > radius + edge) return false;
  if (depth <= 0) return true;
  const t = Math.min(1, depth / CONFIG.maxDepth);
  const lowerRadius = radius * Math.max(0.06, 1 - Math.pow(t, 0.68) * 0.94);
  if (distance > lowerRadius + noise(dx * 0.12, dz * 0.12, seed ^ 0x31) * 2) return false;
  for (let i = 0; i < 3; i++) {
    const r = rng(hash(seed, depth * 17 + i, i * 101));
    const ex = (r() * 2 - 1) * radius * 0.7, ez = (r() * 2 - 1) * radius * 0.7;
    const ey = r() * CONFIG.maxDepth, er = 3 + r() * 7;
    const ddx = dx - ex, ddy = depth - ey, ddz = dz - ez;
    if (ddx * ddx + ddy * ddy + ddz * ddz < er * er && depth > 5) return false;
  }
  return true;
}

// Preserve the original full-volume deletion, but execute it as one native command
// instead of roughly a million individual Script API block operations.
async function clearTestArea(player, cx, cz) {
  const d = player.dimension;
  const r = CONFIG.islandRadius + 3;
  const minX = cx - r, maxX = cx + r;
  const minZ = cz - r, maxZ = cz + r;
  const minY = CONFIG.surfaceY - CONFIG.maxDepth - 2;
  const maxY = CONFIG.maxY;
  player.sendMessage(`§7[IslandAddon] Clearing ${minX},${minY},${minZ} to ${maxX},${maxY},${maxZ} with /fill...`);
  try {
    await d.runCommand(`fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} air`);
  } catch (error) {
    throw new Error(`The /fill clearing command failed: ${error}`);
  }
}

async function buildTestIsland(d, source, cx, cz, seed) {
  const writes = [], r = CONFIG.islandRadius;
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      const c = sourceAt(source, x, z);
      if (!c) continue;
      for (const block of c.blocks) {
        const y = CONFIG.surfaceY + block.dy;
        if (y >= CONFIG.minY && y <= CONFIG.maxY) writes.push({ x: cx + x, y, z: cz + z, permutation: block.permutation });
      }
    }
    if (x % 6 === 0) await system.waitTicks(1);
  }
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      const c = sourceAt(source, x, z);
      if (!c || c.deep.length === 0) continue;
      const random = rng(hash(seed, x, z));
      for (let depth = 1; depth <= CONFIG.maxDepth; depth++) {
        if (!islandInside(x, depth, z, r, seed)) continue;
        writes.push({ x: cx + x, y: CONFIG.surfaceY - depth, z: cz + z, permutation: c.deep[Math.floor(random() * c.deep.length)] });
      }
    }
    if (x % 6 === 0) await system.waitTicks(1);
  }
  for (let i = 0; i < writes.length; i += CONFIG.batch) {
    for (let j = i; j < Math.min(writes.length, i + CONFIG.batch); j++) {
      const w = writes[j]; setBlock(d, w.x, w.y, w.z, w.permutation);
    }
    await system.waitTicks(1);
  }
}

async function runTestIsland(player) {
  if (busy) return;
  busy = true;
  const d = player.dimension, cx = Math.floor(player.location.x), cz = Math.floor(player.location.z);
  let seed = world.getDynamicProperty(CONFIG.seedProperty);
  if (seed === undefined) { seed = hash(cx, cz, Math.floor(world.getAbsoluteTime())); world.setDynamicProperty(CONFIG.seedProperty, seed); }
  seed = Number(seed);
  try {
    player.sendMessage("§a[IslandAddon] Loaded successfully.");
    player.sendMessage("§b[IslandAddon] Starting one-island test at your current position.");
    player.sendMessage(`§7[IslandAddon] Player position: ${cx}, ${Math.floor(player.location.y)}, ${cz}`);
    const loaded = await waitForPlayerArea(player);
    if (!loaded) throw new Error("The player's current chunk could not be read. Move around briefly and rejoin so Bedrock loads the area.");
    player.sendMessage("§7[IslandAddon] Capturing terrain around your position...");
    const source = await captureSource(d, cx, cz);
    player.sendMessage(`§7[IslandAddon] Captured ${source.size} terrain columns.`);
    if (source.size === 0) throw new Error("Player chunk was loaded, but no terrain columns could be read.");
    player.sendMessage("§7[IslandAddon] Deleting test area with native /fill...");
    await clearTestArea(player, cx, cz);
    player.sendMessage("§7[IslandAddon] Carving natural inverted-teardrop island...");
    await buildTestIsland(d, source, cx, cz, seed);
    player.teleport({ x: cx + 0.5, y: CONFIG.surfaceY + 3, z: cz + 0.5 }, { dimension: d });
    player.sendMessage("§a[IslandAddon] One-island test complete!");
    world.setDynamicProperty(CONFIG.runProperty, true);
  } catch (error) {
    player.sendMessage(`§c[IslandAddon] ERROR: ${error}`);
    console.warn(`[IslandAddon] Test island failed: ${error?.stack ?? error}`);
  } finally { busy = false; }
}

world.afterEvents.playerSpawn.subscribe(event => {
  if (!event.initialSpawn || started) return;
  started = true;
  system.runTimeout(() => {
    const player = event.player;
    player.sendMessage("§b[IslandAddon] Addon script started.");
    system.runTimeout(() => runTestIsland(player), 40);
  }, 20);
});
