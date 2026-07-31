import { world, system } from "@minecraft/server";

const CONFIG = {
  dimension: "overworld",
  centerX: 0,
  centerZ: 0,
  sourceRadius: 96,
  islandRadius: 64,
  targetSurfaceY: 72,
  minY: -64,
  maxY: 320,
  maxDepth: 64,
  batchSize: 512,
  chunkSize: 16,
  noiseScale: 0.045,
  roughness: 0.16,
  seedProperty: "islandaddon_seed",
  completeProperty: "islandaddon_complete",
};

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water"]);
const SURFACE = new Set([
  "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol",
  "minecraft:mycelium", "minecraft:grass_path", "minecraft:mud", "minecraft:clay",
  "minecraft:sand", "minecraft:red_sand", "minecraft:gravel", "minecraft:snow",
  "minecraft:snow_layer", "minecraft:moss_block", "minecraft:ice", "minecraft:packed_ice",
  "minecraft:blue_ice", "minecraft:rooted_dirt", "minecraft:farmland", "minecraft:stone",
  "minecraft:deepslate", "minecraft:water", "minecraft:flowing_water"
]);
const STRUCTURE = /(^|:)(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_(log|wood|planks|stem|hyphae|stripped_log|stripped_wood|stripped_stem|stripped_hyphae)$/;
const DEEP = new Set([
  "minecraft:stone", "minecraft:deepslate", "minecraft:tuff", "minecraft:granite",
  "minecraft:diorite", "minecraft:andesite", "minecraft:calcite", "minecraft:dripstone_block"
]);

let running = false;

function hash(x, z, seed) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function rand(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
}

function noise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const s = t => t * t * (3 - 2 * t);
  const v = (a, b) => hash(a, b, seed) / 4294967296 * 2 - 1;
  const a = v(ix, iz), b = v(ix + 1, iz), c = v(ix, iz + 1), d = v(ix + 1, iz + 1);
  const sx = s(fx), sz = s(fz);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

function islandMask(x, z, seed) {
  const nx = x / CONFIG.islandRadius;
  const nz = z / CONFIG.islandRadius;
  const vertical = (nz + 1) * 0.5;
  // Broad/flat upper half, narrowing naturally toward a slightly spiky bottom.
  const taper = nz <= -0.15 ? 1 : Math.max(0.08, 1 - (nz + 0.15) * 0.82);
  const n = noise(x * CONFIG.noiseScale, z * CONFIG.noiseScale, seed);
  const n2 = noise(x * CONFIG.noiseScale * 2.7, z * CONFIG.noiseScale * 2.7, seed ^ 0x51ed270b);
  const radius = 1 + n * CONFIG.roughness + n2 * 0.07;
  const boundary = Math.max(0.04, taper * radius);
  const side = Math.abs(nx) / boundary;
  if (side >= 1 || vertical < 0 || vertical > 1.08) return 0;
  const topShape = nz < 0 ? 1 : 1 - Math.pow(Math.max(0, nz), 2.2) * 0.22;
  const edge = 1 - side;
  const end = nz > 0.72 ? Math.max(0, 1 - (nz - 0.72) / 0.28) : 1;
  return Math.max(0, edge * topShape * end);
}

function isAir(id) { return AIR.has(id); }
function isWater(id) { return WATER.has(id); }
function isStructure(id) { return STRUCTURE.test(id); }
function isSurface(id) {
  if (isAir(id) || isStructure(id)) return false;
  if (SURFACE.has(id)) return true;
  return id.includes("leaves") || id.includes("sapling") || id.includes("flower") ||
    id.includes("grass") || id.includes("fern") || id.includes("mushroom") ||
    id.includes("vine") || id.includes("bush") || id.includes("crop");
}
function isDeep(id) { return DEEP.has(id); }

function findSurface(dimension, x, z) {
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

function captureColumn(dimension, x, z) {
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

async function captureSource(dimension) {
  const source = new Map();
  const total = (CONFIG.sourceRadius * 2 + 1) ** 2;
  let count = 0;
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

function getSource(source, x, z) { return source.get(`${x},${z}`); }

function setAir(dimension, x, y, z) {
  try { dimension.setBlockType({ x, y, z }, "minecraft:air"); } catch (_) {}
}

function setPermutation(dimension, x, y, z, p) {
  try { dimension.setBlockPermutation({ x, y, z }, p); } catch (_) {}
}

async function clearOutside(dimension, source, seed) {
  let ops = 0;
  for (let x = -CONFIG.sourceRadius; x <= CONFIG.sourceRadius; x++) {
    for (let z = -CONFIG.sourceRadius; z <= CONFIG.sourceRadius; z++) {
      if (islandMask(x, z, seed) > 0) continue;
      const col = getSource(source, x, z);
      if (!col) continue;
      const top = Math.min(CONFIG.maxY, col.topY + 1);
      for (let y = CONFIG.minY; y <= top; y++) {
        setAir(dimension, CONFIG.centerX + x, y, CONFIG.centerZ + z);
        if (++ops >= CONFIG.batchSize) { ops = 0; await system.waitTicks(1); }
      }
    }
  }
}

async function buildIsland(dimension, source, seed) {
  const operations = [];
  for (let x = -CONFIG.islandRadius; x <= CONFIG.islandRadius; x++) {
    for (let z = -CONFIG.islandRadius; z <= CONFIG.islandRadius; z++) {
      const mask = islandMask(x, z, seed);
      if (mask <= 0) continue;
      const col = getSource(source, x, z);
      if (!col) continue;
      const surfaceY = CONFIG.targetSurfaceY + Math.round((col.surfaceY - 63) * 0.2);

      // Preserve the source surface and everything above it. This is where trees,
      // houses, villages and other structures are carried onto the island.
      for (const b of col.blocks) {
        if (b.dy < 0) continue;
        const y = surfaceY + b.dy;
        if (y >= CONFIG.minY && y <= CONFIG.maxY) operations.push({ x, y, z, p: b.p });
      }

      // Carve the underside out of the source's real deep layers. We don't create a
      // synthetic palette: each block here is copied from the actual captured chunk.
      const depth = Math.max(2, Math.floor(CONFIG.maxDepth * Math.pow(mask, 0.72)));
      let placed = 0;
      for (let i = col.blocks.length - 1; i >= 0 && placed < depth; i--) {
        const b = col.blocks[i];
        if (!b.deep || b.y >= col.surfaceY) continue;
        const local = rand(hash(x, z, seed) ^ placed);
        if (placed > depth * 0.72 && local() < 0.08) { placed++; continue; }
        const y = surfaceY - placed - 1;
        if (y < CONFIG.minY) break;
        operations.push({ x, y, z, p: b.p });
        placed++;
      }
    }
    if (x % 8 === 0) await system.waitTicks(1);
  }

  for (let i = 0; i < operations.length; i += CONFIG.batchSize) {
    const end = Math.min(operations.length, i + CONFIG.batchSize);
    for (let j = i; j < end; j++) {
      const o = operations[j];
      setPermutation(dimension, CONFIG.centerX + o.x, o.y, CONFIG.centerZ + o.z, o.p);
    }
    await system.waitTicks(1);
  }
}

async function generate() {
  const dimension = world.getDimension(CONFIG.dimension);
  let seed = world.getDynamicProperty(CONFIG.seedProperty);
  if (seed === undefined) {
    seed = hash(Math.floor(world.getAbsoluteTime()), world.getDay(), 0x1a51a7);
    world.setDynamicProperty(CONFIG.seedProperty, seed);
  }

  console.warn("[IslandAddon] Capturing source terrain...");
  const source = await captureSource(dimension);
  console.warn("[IslandAddon] Carving outside the natural island boundary...");
  await clearOutside(dimension, source, Number(seed));
  console.warn("[IslandAddon] Building the carved island from captured terrain...");
  await buildIsland(dimension, source, Number(seed));
  world.setDynamicProperty(CONFIG.completeProperty, true);
  console.warn("[IslandAddon] Complete.");
}

world.afterEvents.playerSpawn.subscribe(event => {
  if (!event.initialSpawn || running) return;
  if (world.getDynamicProperty(CONFIG.completeProperty)) return;
  running = true;
  system.runTimeout(() => generate().catch(e => console.warn(`[IslandAddon] Failed: ${e}`)), 40);
});
