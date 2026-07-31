import { world, system } from "@minecraft/server";
import { CONFIG, hash, noise, islandMask, captureColumn, sourceAt } from "./terrain.js";

const SKY = {
  dimension: "overworld",
  worldRadius: 768,
  islandSpacing: 192,
  islandRadius: 72,
  sourceRadius: 96,
  surfaceY: 110,
  minY: 0,
  maxY: 319,
  maxDepth: 92,
  sourceY: 64,
  batch: 256,
  maxIslands: 48,
  seedProperty: "islandaddon_seed",
  completeProperty: "islandaddon_skyworld_complete",
  progressProperty: "islandaddon_skyworld_progress",
};

let running = false;
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const STRUCTURE = /(^|:)(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_(log|wood|planks|stem|hyphae|stripped_log|stripped_wood|stripped_stem|stripped_hyphae)$/;
const DEEP = new Set(["minecraft:stone", "minecraft:deepslate", "minecraft:tuff", "minecraft:granite", "minecraft:diorite", "minecraft:andesite", "minecraft:calcite", "minecraft:dripstone_block"]);

function isAir(id) { return AIR.has(id); }
function isWater(id) { return WATER.has(id); }
function isStructure(id) { return STRUCTURE.test(id); }
function isDeep(id) { return DEEP.has(id); }
function setAir(d, x, y, z) { try { d.setBlockType({ x, y, z }, "minecraft:air"); } catch {} }
function setBlock(d, x, y, z, p) { try { d.setBlockPermutation({ x, y, z }, p); } catch {} }

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
}

function islandSeed(seed, gx, gz) { return hash(gx, gz, seed ^ 0x9e3779b9); }

function islandCenters(seed) {
  const result = [];
  const grid = Math.ceil(SKY.worldRadius / SKY.islandSpacing);
  const random = rng(seed);
  for (let gx = -grid; gx <= grid; gx++) {
    for (let gz = -grid; gz <= grid; gz++) {
      if (gx === 0 && gz === 0) {
        result.push({ gx, gz, x: 0, z: 0, seed: islandSeed(seed, gx, gz), radius: SKY.islandRadius });
        continue;
      }
      if (result.length >= SKY.maxIslands) continue;
      const s = islandSeed(seed, gx, gz);
      const r = rng(s);
      // Sparse archipelago: deterministic holes in the grid.
      if (r() > 0.62) continue;
      const jitterX = Math.floor((r() - 0.5) * 70);
      const jitterZ = Math.floor((r() - 0.5) * 70);
      const radius = 52 + Math.floor(r() * 30);
      result.push({
        gx, gz,
        x: gx * SKY.islandSpacing + jitterX,
        z: gz * SKY.islandSpacing + jitterZ,
        seed: s,
        radius,
      });
    }
  }
  return result.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
}

function islandMask3D(dx, dy, dz, radius, seed) {
  const nx = dx / radius;
  const nz = dz / radius;
  if (Math.abs(nx) > 1.12 || Math.abs(nz) > 1.12) return false;

  // Top is intentionally broad and almost flat. The underside narrows downward,
  // but erosion makes the silhouette organic instead of a perfect cone/teardrop.
  const edgeNoise = noise(dx * 0.035, dz * 0.035, seed) * 0.16 + noise(dx * 0.10, dz * 0.10, seed ^ 77) * 0.06;
  const horizontal = Math.sqrt(nx * nx + nz * nz);
  const coastline = 1.0 + edgeNoise;
  if (horizontal > coastline) return false;

  const normalizedDepth = Math.max(0, -dy / SKY.maxDepth);
  if (dy > 0) return true;
  const taper = Math.max(0.055, 1 - Math.pow(normalizedDepth, 0.72) * 0.92);
  const bottomX = dx / (radius * taper);
  const bottomZ = dz / (radius * taper);
  if (Math.sqrt(bottomX * bottomX + bottomZ * bottomZ) > 1 + edgeNoise * 0.35) return false;

  // Virtual explosion-like erosion. These are mathematical voids, not actual
  // explosions, avoiding fire, drops, entity damage, and massive event overhead.
  for (let i = 0; i < 5; i++) {
    const s = hash(i, Math.floor(normalizedDepth * 20), seed);
    const rr = rng(s);
    const ex = (rr() * 2 - 1) * radius * 0.75;
    const ez = (rr() * 2 - 1) * radius * 0.75;
    const ey = -rr() * SKY.maxDepth * 0.9;
    const er = 5 + rr() * 14;
    const ddx = dx - ex, ddy = dy - ey, ddz = dz - ez;
    if (ddx * ddx + ddy * ddy + ddz * ddz < er * er && dy < -5) return false;
  }
  return true;
}

function findSurface(dimension, x, z) {
  const top = dimension.getTopmostBlock({ x, z }, SKY.minY);
  if (!top) return null;
  let y = top.location.y;
  // Structures are deliberately ignored while searching for the terrain surface.
  while (y > SKY.minY) {
    const b = dimension.getBlock({ x, y, z });
    if (!b || isAir(b.typeId)) { y--; continue; }
    if (isWater(b.typeId)) { y--; continue; }
    if (!isStructure(b.typeId)) return { y, topY: top.location.y };
    y--;
  }
  return null;
}

function captureColumn(dimension, x, z) {
  const info = findSurface(dimension, x, z);
  if (!info) return null;
  const blocks = [];
  for (let y = SKY.minY; y <= info.topY; y++) {
    const b = dimension.getBlock({ x, y, z });
    if (!b || isAir(b.typeId)) continue;
    blocks.push({ y, dy: y - info.y, p: b.permutation, id: b.typeId, deep: isDeep(b.typeId), water: isWater(b.typeId) });
  }
  return { surfaceY: info.y, topY: info.topY, blocks };
}

async function captureSource(dimension, centerX, centerZ) {
  const source = new Map();
  let n = 0;
  for (let x = -SKY.sourceRadius; x <= SKY.sourceRadius; x++) {
    for (let z = -SKY.sourceRadius; z <= SKY.sourceRadius; z++) {
      const c = captureColumn(dimension, centerX + x, centerZ + z);
      if (c) source.set(`${x},${z}`, c);
      if (++n % 192 === 0) await system.waitTicks(1);
    }
  }
  return source;
}

async function clearDestination(dimension, centerX, centerZ, radius) {
  let n = 0;
  const r = radius + 6;
  for (let x = -r; x <= r; x++) {
    for (let z = -r; z <= r; z++) {
      for (let y = SKY.minY; y <= SKY.maxY; y++) {
        setAir(dimension, centerX + x, y, centerZ + z);
        if (++n >= SKY.batch) { n = 0; await system.waitTicks(1); }
      }
    }
  }
}

async function carveIsland(dimension, island, source) {
  const writes = [];
  const clears = [];
  const radius = island.radius;

  // Surface and structures: source columns are translated so their natural surface
  // sits around the sky-world elevation. This carries trees, villages, paths, houses,
  // and any blocks above the terrain with them.
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const c = sourceAt(source, x, z);
      if (!c) continue;
      const dx = x, dz = z;
      if (Math.sqrt(dx * dx + dz * dz) > radius * 1.12) continue;
      const targetSurface = SKY.surfaceY + Math.round((c.surfaceY - SKY.sourceY) * 0.12);
      for (const b of c.blocks) {
        if (b.dy < 0) continue;
        const y = targetSurface + b.dy;
        if (y >= SKY.minY && y <= SKY.maxY) writes.push({ x: island.x + x, y, z: island.z + z, p: b.p });
      }
    }
    if (x % 8 === 0) await system.waitTicks(1);
  }

  // Carve a 3D inverted-teardrop mass out of actual deep source material. The
  // underside is deliberately irregular and contains virtual explosion voids.
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const c = sourceAt(source, x, z);
      if (!c) continue;
      const targetSurface = SKY.surfaceY + Math.round((c.surfaceY - SKY.sourceY) * 0.12);
      for (let depth = 1; depth <= SKY.maxDepth; depth++) {
        const y = targetSurface - depth;
        if (y < SKY.minY) break;
        if (!islandMask3D(x, -depth, z, radius, island.seed)) {
          clears.push({ x: island.x + x, y, z: island.z + z });
          continue;
        }
        // Select real deep source blocks from progressively deeper source material.
        let chosen = null;
        for (let i = c.blocks.length - 1; i >= 0; i--) {
          if (c.blocks[i].deep && c.blocks[i].y < c.surfaceY) { chosen = c.blocks[i]; break; }
        }
        if (chosen) writes.push({ x: island.x + x, y, z: island.z + z, p: chosen.p });
      }
    }
    if (x % 8 === 0) await system.waitTicks(1);
  }

  for (let i = 0; i < clears.length; i += SKY.batch) {
    for (let j = i; j < Math.min(clears.length, i + SKY.batch); j++) {
      const c = clears[j]; setAir(dimension, c.x, c.y, c.z);
    }
    await system.waitTicks(1);
  }
  for (let i = 0; i < writes.length; i += SKY.batch) {
    for (let j = i; j < Math.min(writes.length, i + SKY.batch); j++) {
      const w = writes[j]; setBlock(dimension, w.x, w.y, w.z, w.p);
    }
    await system.waitTicks(1);
  }
}

async function generateSkyWorld() {
  const dimension = world.getDimension(SKY.dimension);
  let seed = world.getDynamicProperty(SKY.seedProperty);
  if (seed === undefined) {
    seed = hash(Math.floor(world.getAbsoluteTime()), world.getDay(), 0x534b5957);
    world.setDynamicProperty(SKY.seedProperty, seed);
  }
  seed = Number(seed);
  const islands = islandCenters(seed);
  console.warn(`[IslandAddon] Generating sky world: ${islands.length} islands, seed ${seed}`);

  for (let i = 0; i < islands.length; i++) {
    const island = islands[i];
    world.setDynamicProperty(SKY.progressProperty, i);
    console.warn(`[IslandAddon] Island ${i + 1}/${islands.length} at ${island.x}, ${island.z}`);
    const source = await captureSource(dimension, island.x, island.z);
    await clearDestination(dimension, island.x, island.z, island.radius);
    await carveIsland(dimension, island, source);
  }

  world.setDynamicProperty(SKY.progressProperty, islands.length);
  world.setDynamicProperty(SKY.completeProperty, true);
  console.warn("[IslandAddon] Sky world generation complete.");
}

world.afterEvents.playerSpawn.subscribe(event => {
  if (!event.initialSpawn || running) return;
  if (world.getDynamicProperty(SKY.completeProperty)) return;
  running = true;
  system.runTimeout(() => generateSkyWorld().catch(e => console.warn(`[IslandAddon] Sky world failed: ${e}`)), 40);
});
