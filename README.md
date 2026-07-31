# IslandAddon

Minecraft Bedrock behavior pack that transforms the spawn area into a seeded, upside-down teardrop-shaped island.

## What it does

On the first player's initial spawn, the add-on:

- Builds an island centered at `0, 0, 0` in the Overworld.
- Uses an upside-down teardrop footprint.
- Samples the existing generated terrain instead of using a fixed island block palette for the captured surface.
- Pulls surface terrain and blocks above it into the island, allowing trees, village houses, and other structures to be captured.
- Keeps water when encountered.
- Uses stone/deepslate-transition material sampled from the existing world for the island underside.
- Applies seeded variation to the underground material selection.
- Does not intentionally create additional decorative surface blocks.
- Stores a completion marker so the transformation happens only once per world.

## Important implementation note

The Bedrock Script API does not expose a universal direct "world seed" getter across supported API versions. The current implementation persists a generated per-world seed on first run. This makes subsequent generation deterministic for that world, but it is not mathematically derived from the Minecraft world seed.

The source capture and placement system is intentionally implemented through the official `@minecraft/server` Script API. `Dimension.getBlock`, `getTopmostBlock`, and `setBlockPermutation` are used for terrain inspection and placement. The API requires the relevant chunks to be loaded for block access, so generation is performed in batches.

## Build

Requires Node.js 22+.

```bash
npm ci
npm run build
```

The output is placed in `dist/` as:

```text
IslandAddon-1.0.0-v<build>.mcaddon
```

## GitHub Actions

`.github/workflows/build.yml` automatically builds the addon on pushes and uploads the `.mcaddon` as an artifact. Builds on `main` also create a GitHub Release.

The `v##` identifier is generated from the GitHub Actions run number. Each build generates fresh pack and script UUIDs, so every built version has unique identifiers.

## Supported API

The project currently targets the stable `@minecraft/server` 2.0.0 dependency. The Minecraft Script API is actively evolving, so API compatibility should be checked when moving to a newer Bedrock release.
