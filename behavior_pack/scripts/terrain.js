import { system } from "@minecraft/server";

export const CONFIG = {
  centerX: 0,
  centerZ: 0,
  sourceRadius: 96,
  islandRadius: 64,
  targetSurfaceY: 72,
  minY: -64,
  maxY: 320,
  maxDepth: 64,
  batchSize: 512,
  noiseScale: 0.045,
  roughness: 0.16,
};

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const STRUCTURE = /(^|:)(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_(log|wood|planks|stem|hyphae|stripped_log|stripped_wood|stripped_stem|stripped_hyphae)$/;
const SURFACE = new Set([
  "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol", "minecraft:mycelium",
  "minecraft:grass_path", "minecraft:mud", "minecraft:clay", "minecraft:sand", "minecraft:red_sand",
  "minecraft:gravel", "minecraft:snow", "minecraft:snow_layer", "minecraft:moss_block", "minecraft:ice",
  "minecraft:packed_ice", "minecraft:blue_ice", "minecraft:rooted_dirt", "minecraft:farmland",
  "minecraft:water", "minecraft:flowing_water"
]);
const DEEP = new Set([
  "minecraft:stone", "minecraft:deepslate", "minecraft:tuff", "minecraft:granite", "minecraft:diorite",
  "minecraft:andesite", "minecraft:calcite", "minecraft:dripstone_block"
]);

export function hash(x, z, seed) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function noise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const s = t => t * t * (3 - 2 * t);
  const v = (a, b) => hash(a, b, seed) / 4294967296 * 2 - 1;
  const a = v(ix, iz), b = v(ix + 1, iz), c = v(ix, iz + 1), d = v(ix + 1, iz + 1);
  const sx = s(fx), sz = s(fz);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

// A naturalized inverted-teardrop footprint: broad and almost flat at the top,
// irregular along the coast, narrowing into an asymmetric rocky point below.
export function islandMask(x, z, radius, seed) {
  const nx = x / radius, nz = z / radius;
  if (Math.abs(nx) > 1.08 || nz < -1.05 || nz > 1.08) return 0;
  const taper = nz <= -0.15 ? 1 : Math.max(0.055, 1 - (nz + 0.15) * 0.86);
  const n1 = noise(x * 0.045, z * 0.045, seed);
  const n2 = noise(x * 0.12, z * 0.12, seed ^ 0x51ed270b);
  const irregular = 1 + n1 * 0.16 + n2 * 0.07;
  const side = Math.abs(nx) / Math.max(0.03, taper * irregular);
  if (side >= 1) return 0;
  const edge = 1 - side;
  const point = nz > 0.70 ? Math.max(0, 1 - (nz - 0.70) / 0.30) : 1;
  return Math.max(0, edge * point);
}

export function isAir(id) { return AIR.has(id); }
export function isWater(id) { return WATER.has(id); }
export function isStructure(id) { return STRUCTURE.test(id); }
export function isSurface(id) {
  if (isAir(id) || isStructure(id)) return false;
  if (SURFACE.has(id)) return true;
  return id.includes("leaves") || id.includes("sapling") || id.includes("flower") || id.includes("grass") ||
    id.includes("fern") || id.includes("mushroom") || id.includes("vine") || id.includes("bush") || id.includes("crop");
}
export function isDeep(id) { return DEEP.has(id); }

export function findSurface(dimension, x, z) {
  const top = dimension.getTopmostBlock({ x, z }, CONFIG.minY);
  if (!top) return null;
  let surfaceY = top.location.y;
  for (let y = top.location.y; y >= CONFIG.minY; y--) {
    const b = dimension.getBlock({ x, y, z });
    if (!b || isAir(b.typeId)) continue;
    if (isWater(b.typeId)) { surfaceY = y; continue; }
    if (isSurface(b.typeId)) { surfaceY = y; break; }
    if (!isStructure(b.typeId)) { surfaceY = y; break; }
  }
  return { surfaceY, topY: top.location.y };
}

// Snapshot an actual column. The snapshot contains the real block permutations,
// not a generated palette, so the carving operation can be deterministic and lossless
// with respect to the material that is selected for the island.
export function captureColumn(dimension, x, z) {
  const info = findSurface(dimension, x, z);
  if (!info) return null;
  const blocks = [];
  for (let y = CONFIG.minY; y <= info.topY; y++) {
    const b = dimension.getBlock({ x, y, z });
    if (!b || isAir(b.typeId)) continue;
    blocks.push({ y, dy: y - info.surfaceY, p: b.permutation, id: b.typeId, deep: isDeep(b.typeId) });
  }
  return { surfaceY: info.surfaceY, topY: info.topY, blocks };
}

export async function captureRegion(dimension) {
  const source = new Map();
  let count = 0;
  const diameter = CONFIG.sourceRadius * 2 + 1;
  const total = diameter * diameter;
  for (let x = -CONFIG.sourceRadius; x <= CONFIG.sourceRadius; x++) {
    for (let z = -CONFIG.sourceRadius; z <= CONFIG.sourceRadius; z++) {
      const col = captureColumn(dimension, CONFIG.centerX + x, CONFIG.centerZ + z);
      if (col) source.set(`${x},${z}`, col);
      count++;
      if (count % 128 === 0) await system.waitTicks(1);
    }
  }
  return source;
}

export function sourceAt(source, x, z) { return source.get(`${x},${z}`) ?? null; }

export async function runBatches(items, fn) {
  for (let i = 0; i < items.length; i += CONFIG.batchSize) {
    const end = Math.min(items.length, i + CONFIG.batchSize);
    for (let j = i; j < end; j++) fn(items[j]);
    await system.waitTicks(1);
  }
}
