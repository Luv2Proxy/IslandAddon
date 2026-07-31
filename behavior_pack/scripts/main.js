import { world, system, BlockPermutation } from "@minecraft/server";

const CFG = {
  dimension: "overworld",
  centerX: 0,
  centerZ: 0,
  radius: 48,
  topY: 96,
  bottomY: -48,
  depth: 42,
  sourceRadius: 80,
  maxSurfaceCaptureHeight: 80,
  batchSize: 250,
  seaLevel: 63,
  // Increase this to make the island hang farther downward.
  undersideExponent: 1.65,
};

const SURFACE = new Set([
  "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol",
  "minecraft:mycelium", "minecraft:grass_path", "minecraft:mud", "minecraft:clay",
  "minecraft:sand", "minecraft:red_sand", "minecraft:gravel", "minecraft:snow",
  "minecraft:snow_layer", "minecraft:stone", "minecraft:deepslate", "minecraft:rooted_dirt",
  "minecraft:farmland", "minecraft:moss_block", "minecraft:ice", "minecraft:packed_ice",
  "minecraft:blue_ice", "minecraft:water", "minecraft:flowing_water", "minecraft:lava",
  "minecraft:flowing_lava"
]);

const NON_SURFACE_SOLIDS = new Set([
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log", "minecraft:jungle_log",
  "minecraft:acacia_log", "minecraft:dark_oak_log", "minecraft:mangrove_log", "minecraft:cherry_log",
  "minecraft:oak_planks", "minecraft:spruce_planks", "minecraft:birch_planks", "minecraft:jungle_planks",
  "minecraft:acacia_planks", "minecraft:dark_oak_planks", "minecraft:mangrove_planks", "minecraft:cherry_planks"
]);

let started = false;

function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
}

function isSurfaceId(id) {
  if (SURFACE.has(id)) return true;
  if (NON_SURFACE_SOLIDS.has(id)) return false;
  return id.endsWith("_leaves") || id.endsWith("_leaves2") || id.endsWith("_sapling") ||
    id.includes("flower") || id.includes("mushroom") || id.includes("grass") || id.includes("fern") ||
    id.includes("crop") || id.includes("vine") || id.includes("bush") || id.includes("tallgrass");
}

function isAir(id) {
  return id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";
}

function isWater(id) {
  return id === "minecraft:water" || id === "minecraft:flowing_water";
}

function isUsefulBlock(block) {
  return block && !isAir(block.typeId);
}

function teardropMask(x, z, r) {
  const nx = x / r;
  const nz = z / r;
  const d = Math.sqrt(nx * nx + nz * nz);
  if (d > 1) return 0;
  // Rounded top with a pointed lower tip: upside-down teardrop.
  const vertical = 1 - 0.48 * Math.max(0, nz);
  const width = Math.max(0.08, vertical);
  const edge = Math.sqrt(Math.max(0, 1 - (nz * 0.92) ** 2));
  const local = Math.abs(nx) / Math.max(0.05, edge * width);
  return Math.max(0, 1 - local) * Math.max(0, 1 - d * 0.08);
}

function getSurfaceAndAbove(dimension, x, z) {
  const top = dimension.getTopmostBlock({ x, z }, CFG.bottomY);
  if (!top) return null;
  let y = top.location.y;
  let surfaceY = y;
  let found = false;

  for (let yy = y; yy >= CFG.bottomY; yy--) {
    const b = dimension.getBlock({ x, y: yy, z });
    if (!b) continue;
    const id = b.typeId;
    if (isAir(id)) continue;
    if (isWater(id)) {
      if (!found) surfaceY = yy;
      found = true;
      continue;
    }
    if (isSurfaceId(id) || NON_SURFACE_SOLIDS.has(id)) {
      surfaceY = yy;
      found = true;
      break;
    }
  }
  return { topY: y, surfaceY };
}

function captureColumn(dimension, x, z, rngFn) {
  const info = getSurfaceAndAbove(dimension, x, z);
  if (!info) return { blocks: [], surfaceY: CFG.seaLevel };
  const blocks = [];
  const start = Math.min(info.topY, CFG.topY + CFG.maxSurfaceCaptureHeight);
  for (let y = start; y >= info.surfaceY; y--) {
    const b = dimension.getBlock({ x, y, z });
    if (!isUsefulBlock(b)) continue;
    blocks.push({
      dy: y - info.surfaceY,
      permutation: b.permutation,
      id: b.typeId,
      water: isWater(b.typeId),
      // Small deterministic jitter lets nearby source columns vary naturally.
      jitter: rngFn() < 0.08
    });
  }
  return { blocks, surfaceY: info.surfaceY };
}

function buildDeepPalette(dimension, seed, rngFn) {
  const palette = [];
  for (let x = -CFG.sourceRadius; x <= CFG.sourceRadius; x += 8) {
    for (let z = -CFG.sourceRadius; z <= CFG.sourceRadius; z += 8) {
      const wx = CFG.centerX + x;
      const wz = CFG.centerZ + z;
      const info = getSurfaceAndAbove(dimension, wx, wz);
      if (!info) continue;
      const base = Math.max(CFG.bottomY, info.surfaceY - 18);
      for (let y = base; y >= Math.max(CFG.bottomY, base - 55); y--) {
        const b = dimension.getBlock({ x: wx, y, z: wz });
        if (!b || isAir(b.typeId) || isWater(b.typeId)) continue;
        if (b.typeId === "minecraft:stone" || b.typeId === "minecraft:deepslate" ||
            b.typeId === "minecraft:tuff" || b.typeId === "minecraft:granite" ||
            b.typeId === "minecraft:diorite" || b.typeId === "minecraft:andesite") {
          palette.push(b.permutation);
        }
      }
    }
  }
  return palette;
}

function chooseDeep(palette, rngFn) {
  if (!palette.length) return BlockPermutation.resolve("minecraft:stone");
  return palette[Math.floor(rngFn() * palette.length)];
}

async function generateIsland() {
  const dimension = world.getDimension(CFG.dimension);
  const seed = hashSeed(world.getAbsoluteTime() ^ world.getDay() ^ String(world.getDynamicProperty("islandaddon_seed") ?? world.getDefaultSpawnLocation().x));
  const random = rng(seed);

  // Save a stable per-world seed. The actual world seed is not exposed consistently
  // by all Script API versions, so we derive a deterministic seed once and persist it.
  if (world.getDynamicProperty("islandaddon_seed") === undefined) {
    world.setDynamicProperty("islandaddon_seed", seed);
  }

  const source = new Map();
  for (let x = -CFG.sourceRadius; x <= CFG.sourceRadius; x++) {
    for (let z = -CFG.sourceRadius; z <= CFG.sourceRadius; z++) {
      const wx = CFG.centerX + x;
      const wz = CFG.centerZ + z;
      source.set(`${wx},${wz}`, captureColumn(dimension, wx, wz, random));
    }
    await system.waitTicks(1);
  }

  const deepPalette = buildDeepPalette(dimension, seed, random);
  const operations = [];

  for (let x = -CFG.radius; x <= CFG.radius; x++) {
    for (let z = -CFG.radius; z <= CFG.radius; z++) {
      const mask = teardropMask(x, z, CFG.radius);
      if (mask <= 0) continue;

      const src = source.get(`${CFG.centerX + x},${CFG.centerZ + z}`);
      if (!src) continue;
      const targetSurface = CFG.seaLevel + Math.floor(mask * 5);
      const surfaceBlocks = src.blocks;

      // Pull the captured surface/structure column into the island. Nothing is
      // synthesized for this layer: every block comes from an existing source column.
      for (const block of surfaceBlocks) {
        const ty = targetSurface + block.dy;
        if (ty < CFG.bottomY || ty > CFG.topY + CFG.maxSurfaceCaptureHeight) continue;
        operations.push({ x: CFG.centerX + x, y: ty, z: CFG.centerZ + z, p: block.permutation });
      }

      // The underside is a tapered, upside-down teardrop. Its deep material is
      // sampled from the stone/deepslate transition palette, with seeded variation.
      const thickness = Math.max(1, Math.floor(CFG.depth * Math.pow(mask, CFG.undersideExponent)));
      for (let d = 1; d <= thickness; d++) {
        const y = targetSurface - d;
        if (y < CFG.bottomY) break;
        const transition = d / thickness;
        const p = chooseDeep(deepPalette, random);
        // Keep a little natural variation without creating additional volume.
        if (transition > 0.72 && random() < 0.18) continue;
        operations.push({ x: CFG.centerX + x, y, z: CFG.centerZ + z, p });
      }
    }
    await system.waitTicks(1);
  }

  // Write in batches to avoid a single huge tick and let chunks load progressively.
  for (let i = 0; i < operations.length; i += CFG.batchSize) {
    const batch = operations.slice(i, i + CFG.batchSize);
    for (const op of batch) {
      try {
        dimension.setBlockPermutation({ x: op.x, y: op.y, z: op.z }, op.p);
      } catch (_) {}
    }
    await system.waitTicks(1);
  }

  world.setDynamicProperty("islandaddon_complete", true);
}

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn || started) return;
  if (world.getDynamicProperty("islandaddon_complete")) return;
  started = true;
  system.runTimeout(() => {
    generateIsland().catch((e) => console.warn(`[IslandAddon] Generation failed: ${e}`));
  }, 20);
});
