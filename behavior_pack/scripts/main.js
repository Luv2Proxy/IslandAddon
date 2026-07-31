import { world, system } from "@minecraft/server";
import { hash, noise, sourceAt } from "./terrain.js";

const CONFIG = {
  surfaceY: 120,
  islandRadius: 30,
  surfaceLayers: 4,
  maxDepth: 24,
  minY: -64,
  maxY: 319,
  batch: 128,
  runProperty: "islandaddon_test_complete",
  seedProperty: "islandaddon_seed",
  stagingOffsetX: 256,
  stagingOffsetZ: 0,
};

let started = false;
let busy = false;
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const OCEAN_BIOMES = new Set(["ocean", "deep_ocean", "lukewarm_ocean", "deep_lukewarm_ocean", "warm_ocean", "cold_ocean", "deep_cold_ocean", "frozen_ocean", "deep_frozen_ocean"]);
const GRAVITY_BLOCKS = new Set(["minecraft:sand", "minecraft:red_sand", "minecraft:gravel", "minecraft:concrete_powder", "minecraft:red_concrete_powder", "minecraft:orange_concrete_powder", "minecraft:yellow_concrete_powder", "minecraft:lime_concrete_powder", "minecraft:green_concrete_powder", "minecraft:cyan_concrete_powder", "minecraft:light_blue_concrete_powder", "minecraft:blue_concrete_powder", "minecraft:purple_concrete_powder", "minecraft:magenta_concrete_powder", "minecraft:pink_concrete_powder", "minecraft:brown_concrete_powder", "minecraft:black_concrete_powder", "minecraft:gray_concrete_powder", "minecraft:light_gray_concrete_powder", "minecraft:white_concrete_powder"]);
const ICE_BLOCKS = new Set(["minecraft:ice", "minecraft:packed_ice", "minecraft:blue_ice"]);

function isAir(id) { return AIR.has(id); }
function isWater(id) { return WATER.has(id); }
function isGravity(id) { return GRAVITY_BLOCKS.has(id); }
function isIce(id) { return ICE_BLOCKS.has(id); }
function isNaturalSurface(id) {
  return id.includes("grass") || id.includes("dirt") || id.includes("stone") || id.includes("sand") || id.includes("gravel") ||
    id.includes("clay") || id.includes("mud") || id.includes("snow") || id.includes("podzol") || id.includes("mycelium") ||
    id.includes("path") || id.includes("farmland") || id.includes("netherrack") || id.includes("nylium") || id.includes("soul_sand") ||
    id.includes("soul_soil") || id.includes("deepslate");
}
function isDeepMaterial(id) {
  return id === "minecraft:stone" || id === "minecraft:deepslate" || id === "minecraft:tuff" || id === "minecraft:granite" ||
    id === "minecraft:diorite" || id === "minecraft:andesite" || id === "minecraft:calcite" || id === "minecraft:dripstone_block";
}
function rng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0; return (x >>> 0) / 4294967296; };
}
function setBlock(d, x, y, z, p) { const b = d.getBlock({ x, y, z }); if (b) b.setPermutation(p); }
function getBlock(d, x, y, z) { try { return d.getBlock({ x, y, z }); } catch { return null; } }

function playerChunkLoaded(d, cx, cz) {
  const probes = [[cx, cz], [cx + 8, cz], [cx - 8, cz], [cx, cz + 8], [cx, cz - 8], [cx + 15, cz + 15], [cx - 15, cz + 15], [cx + 15, cz - 15], [cx - 15, cz - 15]];
  let loaded = 0;
  for (const [x, z] of probes) if (getBlock(d, x, CONFIG.surfaceY, z)) loaded++;
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

function getBiomeId(d, x, y, z) {
  try {
    const b = d.getBiome({ x, y, z });
    return b?.id ?? b?.typeId ?? "";
  } catch { return ""; }
}
function isOceanBiome(d, x, y, z) {
  const id = String(getBiomeId(d, x, y, z)).toLowerCase();
  return OCEAN_BIOMES.has(id) || id.endsWith(":ocean") || id.includes("ocean");
}

function findTerrainSurface(d, x, z) {
  if (isOceanBiome(d, x, CONFIG.surfaceY, z)) return null;
  if (!getBlock(d, x, CONFIG.surfaceY, z)) return null;
  let iceTop = null, iceCount = 0;
  for (let y = Math.min(CONFIG.maxY, CONFIG.surfaceY + 64); y >= CONFIG.minY; y--) {
    const b = getBlock(d, x, y, z);
    if (!b) return null;
    if (isIce(b.typeId)) { if (iceTop === null) iceTop = y; iceCount++; continue; }
    if (!isAir(b.typeId) && !isWater(b.typeId)) {
      if (iceCount >= 3) return { y: iceTop, ice: true };
      if (isNaturalSurface(b.typeId)) return { y, ice: false };
      iceCount = 0;
    }
  }
  return null;
}

async function captureSource(d, cx, cz) {
  const source = new Map();
  let scanned = 0;
  const r = CONFIG.islandRadius;
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      const sx = cx + x, sz = cz + z, surface = findTerrainSurface(d, sx, sz);
      if (!surface) continue;
      const blocks = [], deep = [];
      for (let y = surface.y; y <= Math.min(CONFIG.maxY, surface.y + 64); y++) {
        const b = getBlock(d, sx, y, sz);
        if (b && !isAir(b.typeId)) blocks.push({ dy: y - surface.y, permutation: b.permutation, typeId: b.typeId });
      }
      for (let y = surface.y - 1; y >= Math.max(CONFIG.minY, surface.y - 48); y--) {
        const b = getBlock(d, sx, y, sz);
        if (b && !isAir(b.typeId) && !isWater(b.typeId) && isDeepMaterial(b.typeId)) deep.push(b.permutation);
      }
      source.set(`${x},${z}`, { surfaceY: surface.y, ice: surface.ice, blocks, deep });
      if (++scanned % 32 === 0) await system.waitTicks(1);
    }
  }
  return source;
}

function islandInside(dx, depth, dz, radius, seed) {
  const distance = Math.sqrt(dx * dx + dz * dz);
  const edge = noise(dx * 0.08, dz * 0.08, seed) * 3.5 + noise(dx * 0.025, dz * 0.025, seed ^ 0x71) * 4;
  if (distance > radius + edge) return false;
  if (depth <= 0) return true;
  const t = Math.min(1, depth / CONFIG.maxDepth);
  const lowerRadius = radius * Math.max(0.10, 1 - Math.pow(t, 0.72) * 0.90);
  if (distance > lowerRadius + noise(dx * 0.12, dz * 0.12, seed ^ 0x31) * 1.5) return false;
  for (let i = 0; i < 2; i++) {
    const r = rng(hash(seed, depth * 17 + i, i * 101));
    const ex = (r() * 2 - 1) * radius * 0.7, ez = (r() * 2 - 1) * radius * 0.7;
    const ey = r() * CONFIG.maxDepth, er = 2 + r() * 5;
    const ddx = dx - ex, ddy = depth - ey, ddz = dz - ez;
    if (ddx * ddx + ddy * ddy + ddz * ddz < er * er && depth > 4) return false;
  }
  return true;
}

async function clearTestArea(player, cx, cz) {
  const d = player.dimension, r = CONFIG.islandRadius + 3;
  const minX = cx - r, maxX = cx + r, minZ = cz - r, maxZ = cz + r;
  const minY = CONFIG.surfaceY - CONFIG.maxDepth - 2, maxY = CONFIG.maxY;
  player.sendMessage(`§7[IslandAddon] Clearing ${minX},${minY},${minZ} to ${maxX},${maxY},${maxZ} with /fill...`);
  await d.runCommand(`fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} air`);
}

async function cloneBottomSection(player, cx, cz) {
  const d = player.dimension, r = CONFIG.islandRadius;
  const sx1 = cx - r, sz1 = cz - r, sx2 = cx + r, sz2 = cz + r;
  const stagingX1 = sx1 + CONFIG.stagingOffsetX, stagingX2 = sx2 + CONFIG.stagingOffsetX;
  const minY = CONFIG.surfaceY - CONFIG.maxDepth, maxY = CONFIG.surfaceY - CONFIG.surfaceLayers;
  player.sendMessage("§7[IslandAddon] Cloning staged bottom terrain back into the island...");
  await d.runCommand(`clone ${stagingX1} ${minY} ${sz1} ${stagingX2} ${maxY} ${sz2} ${sx1} ${minY} ${sz1} replace`);
}

async function clearStagingArea(player, cx, cz) {
  const d = player.dimension, r = CONFIG.islandRadius;
  const minX = cx - r + CONFIG.stagingOffsetX;
  const maxX = cx + r + CONFIG.stagingOffsetX;
  const minZ = cz - r;
  const maxZ = cz + r;
  const minY = CONFIG.surfaceY - CONFIG.maxDepth;
  const maxY = CONFIG.surfaceY - CONFIG.surfaceLayers;
  player.sendMessage("§7[IslandAddon] Deleting old staged source area...");
  await d.runCommand(`fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} air`);
  player.sendMessage("§7[IslandAddon] Old source area deleted.");
}

async function buildTestIsland(player, source, cx, cz, seed) {
  const d = player.dimension, r = CONFIG.islandRadius;
  await cloneBottomSection(player, cx, cz);
  const surfaceWrites = [], gravityWrites = [], structureWrites = [];
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      const c = sourceAt(source, x, z);
      if (!c) continue;
      const curve = Math.round(noise(x * 0.055, z * 0.055, seed ^ 0x55) * 1.5 + noise(x * 0.13, z * 0.13, seed ^ 0xAA) * 0.7);
      const baseY = CONFIG.surfaceY + curve;
      for (const block of c.blocks) {
        if (block.dy < 0) continue;
        const y = baseY + block.dy;
        if (y < CONFIG.minY || y > CONFIG.maxY) continue;
        if (block.dy < CONFIG.surfaceLayers) {
          surfaceWrites.push({ x: cx + x, y, z: cz + z, permutation: block.permutation, typeId: block.typeId });
        } else {
          structureWrites.push({ x: cx + x, y, z: cz + z, permutation: block.permutation, typeId: block.typeId });
        }
      }
      if (c.ice) {
        const random = rng(hash(seed ^ 0x1CE, x, z));
        if (random() < 0.22) {
          const chunkDepth = 1 + Math.floor(random() * 3);
          for (let depth = 1; depth <= chunkDepth; depth++) {
            if (!islandInside(x, depth, z, r * 0.7, seed ^ 0x1CE)) continue;
            const ice = c.blocks.find(b => isIce(b.typeId));
            if (ice) surfaceWrites.push({ x: cx + x, y: baseY - depth, z: cz + z, permutation: ice.permutation, typeId: ice.typeId });
          }
        }
      }
    }
    if (x % 6 === 0) await system.waitTicks(1);
  }
  gravityWrites.push(...surfaceWrites.filter(w => isGravity(w.typeId)).sort((a, b) => a.y - b.y));
  const stableSurface = surfaceWrites.filter(w => !isGravity(w.typeId));
  for (let i = 0; i < stableSurface.length; i += CONFIG.batch) {
    for (let j = i; j < Math.min(stableSurface.length, i + CONFIG.batch); j++) {
      const w = stableSurface[j]; setBlock(d, w.x, w.y, w.z, w.permutation);
    }
    await system.waitTicks(1);
  }
  for (const w of gravityWrites) setBlock(d, w.x, w.y, w.z, w.permutation);
  for (let i = 0; i < structureWrites.length; i += CONFIG.batch) {
    for (let j = i; j < Math.min(structureWrites.length, i + CONFIG.batch); j++) {
      const w = structureWrites[j]; setBlock(d, w.x, w.y, w.z, w.permutation);
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
    if (!await waitForPlayerArea(player)) throw new Error("The player's current chunk could not be read.");
    player.sendMessage("§7[IslandAddon] Capturing terrain around your position...");
    const source = await captureSource(d, cx, cz);
    player.sendMessage(`§7[IslandAddon] Captured ${source.size} terrain columns (ocean columns skipped).`);
    if (source.size === 0) throw new Error("No non-ocean terrain columns could be read.");
    player.sendMessage("§7[IslandAddon] Staging bottom section for native /clone...");
    const r = CONFIG.islandRadius;
    await d.runCommand(`clone ${cx - r} ${CONFIG.surfaceY - CONFIG.maxDepth} ${cz - r} ${cx + r} ${CONFIG.surfaceY - CONFIG.surfaceLayers} ${cz + r} ${cx - r + CONFIG.stagingOffsetX} ${CONFIG.surfaceY - CONFIG.maxDepth} ${cz - r} replace`);
    player.sendMessage("§7[IslandAddon] Deleting test area with native /fill...");
    await clearTestArea(player, cx, cz);
    player.sendMessage("§7[IslandAddon] Carving and rebuilding natural inverted-teardrop island...");
    await buildTestIsland(player, source, cx, cz, seed);
    // The island is now fully generated. Only now is the temporary old-world staging copy deleted.
    await clearStagingArea(player, cx, cz);
    player.teleport({ x: cx + 0.5, y: CONFIG.surfaceY + 4, z: cz + 0.5 }, { dimension: d });
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
