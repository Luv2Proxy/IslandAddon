import { system } from "@minecraft/server";

export const ISLAND_CONFIG = {
  center: { x: 0, z: 0 },
  sourceRadius: 96,
  islandRadius: 64,
  targetSurfaceY: 72,
  minY: -64,
  maxY: 320,
  maxDepth: 64,
  batchColumns: 32,
  noiseScale: 0.055,
  noiseAmplitude: 0.18,
  edgeRoughness: 0.13,
};

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const STRUCTURE_MATERIAL = /(^|:)(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_(log|wood|planks|stem|hyphae|stripped_log|stripped_wood|stripped_stem|stripped_hyphae)$/;
const SURFACE = new Set([
  "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol",
  "minecraft:mycelium", "minecraft:grass_path", "minecraft:mud", "minecraft:clay",
  "minecraft:sand", "minecraft:red_sand", "minecraft:gravel", "minecraft:snow",
  "minecraft:snow_layer", "minecraft:moss_block", "minecraft:ice", "minecraft:packed_ice",
  "minecraft:blue_ice", "minecraft:rooted_dirt", "minecraft:farmland", "minecraft:water",
  "minecraft:flowing_water"
]);
const DEEP = new Set([
  "minecraft:stone", "minecraft:deepslate", "minecraft:tuff", "minecraft:granite",
  "minecraft:diorite", "minecraft:andesite", "minecraft:calcite", "minecraft:dripstone_block"
]);

export function makeRng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
}

export function hash2(x, z, seed = 0) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const smooth = t => t * t * (3 - 2 * t);
  const v = (a, b) => (hash2(a, b, seed) / 4294967296) * 2 - 1;
  const sx = smooth(fx), sz = smooth(fz);
  const a = v(ix, iz), b = v(ix + 1, iz), c = v(ix, iz + 1), d = v(ix + 1, iz + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

export function naturalIslandMask(x, z, radius, seed) {
  const nx = x / radius, nz = z / radius;
  const distance = Math.sqrt(nx * nx + nz * nz);
  if (distance > 1.12) return 0;

  // Broad, mostly flat top; increasingly narrow toward the lower point.
  // This is deliberately NOT a mathematical teardrop: noise creates bays,
  // headlands and irregular edges while preserving the requested silhouette.
  const vertical = (nz + 1) * 0.5;
  const topFlat = Math.max(0, 1 - Math.pow(Math.max(0, vertical - 0.08) / 0.92, 2.4));
  const taper = 1 - 0.72 * Math.max(0, nz);
  const baseWidth = Math.max(0.07, taper);
  const n = valueNoise(x * ISLAND_CONFIG.noiseScale, z * ISLAND_CONFIG.noiseScale, seed);
  const n2 = valueNoise(x * ISLAND_CONFIG.noiseScale * 2.3, z * ISLAND_CONFIG.noiseScale * 2.3, seed ^ 0x51ed270b);
  const irregularRadius = 1 + n * ISLAND_CONFIG.noiseAmplitude + n2 * ISLAND_CONFIG.edgeRoughness;
  const normalizedX = Math.abs(nx) / Math.max(0.03, baseWidth * irregularRadius);

  if (normalizedX >= 1) return 0;
  const edge = 1 - normalizedX;
  const bottomPoint = Math.max(0, nz - 0.68) / 0.32;
  const pointCut = Math.max(0, 1 - bottomPoint * 0.7);
  return Math.max(0, edge * pointCut * (1 - Math.max(0, distance - 0.85) * 2));
}

function isAir(id) { return AIR.has(id); }
function isWater(id) { return WATER.has(id); }
function isStructureMaterial(id) { return STRUCTURE_MATERIAL.test(id); }

export function isSurface(id) {
  if (isAir(id) || isStructureMaterial(id)) return false;
  if (SURFACE.has(id)) return true;
  return id.includes("leaves") || id.includes("sapling") || id.includes("flower") ||
    id.includes("grass") || id.includes("fern") || id.includes("mushroom") ||
    id.includes("vine") || id.includes("bush") || id.includes("crop");
}

export function isDeep(id) { return DEEP.has(id); }

export function findSurface(dimension, x, z, minY) {
  const top = dimension.getTopmostBlock({ x, z }, minY);
  if (!top) return null;
  let surfaceY = top.location.y;
  for (let y = top.location.y; y >= minY; y--) {
    const b = dimension.getBlock({ x, y, z });
    if (!b || isAir(b.typeId)) continue;
    if (isWater(b.typeId)) { surfaceY = y; continue; }
    if (isSurface(b.typeId)) { surfaceY = y; break; }
    if (!isStructureMaterial(b.typeId)) { surfaceY = y; break; }
  }
  return { surfaceY, topY: top.location.y };
}

// Captures actual blocks from a source chunk. Nothing is synthesized here.
export function captureColumn(dimension, x, z, minY) {
  const info = findSurface(dimension, x, z, minY);
  if (!info) return null;
  const blocks = [];
  for (let y = minY; y <= info.topY; y++) {
    const b = dimension.getBlock({ x, y, z });
    if (!b || isAir(b.typeId)) continue;
    blocks.push({
      y,
      dy: y - info.surfaceY,
      permutation: b.permutation,
      typeId: b.typeId,
      water: isWater(b.typeId),
      deep: isDeep(b.typeId),
    });
  }
  return { surfaceY: info.surfaceY, topY: info.topY, blocks };
}

export async function captureRegion(dimension, config) {
  const source = new Map();
  for (let x = -config.sourceRadius; x <= config.sourceRadius; x++) {
    for (let z = -config.sourceRadius; z <= config.sourceRadius; z++) {
      const col = captureColumn(dimension, config.center.x + x, config.center.z + z, config.minY);
      if (col) source.set(`${x},${z}`, col);
    }
    await system.waitTicks(1);
  }
  return source;
}

export function getSource(source, x, z) {
  return source.get(`${x},${z}`) ?? null;
}
