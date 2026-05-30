# Ionrift Quartermaster

![Downloads](https://img.shields.io/github/downloads/ionrift-gm/ionrift-quartermaster/total?color=violet&label=Downloads)
![Latest Release](https://img.shields.io/github/v/release/ionrift-gm/ionrift-quartermaster?color=violet&label=Latest%20Version)
![Foundry v12+](https://img.shields.io/badge/Foundry-v12%2B-333333?style=flat&logo=foundryvirtualtabletop)
![Systems](https://img.shields.io/badge/system-dnd5e-blue)

**The GM's loot engine for Foundry VTT.** Terrain-aware cache generation, masked item identification, scroll management, cursed item tracking, and campaign item planning.

### Support Ionrift

[![Patreon](https://img.shields.io/badge/Patreon-ionrift-ff424d?logo=patreon&logoColor=white)](https://patreon.com/ionrift)
[![Discord](https://img.shields.io/badge/Discord-Ionrift-5865F2?logo=discord&logoColor=white)](https://discord.gg/vFGXf7Fncj)

> Documentation, setup guides, and troubleshooting: **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)**

### Demo

[![Watch the trailer](https://img.youtube.com/vi/DBLM4srxaGE/maxresdefault.jpg)](https://youtu.be/DBLM4srxaGE)

*Cache generation, drag-to-canvas deployment, masked item identification, and campaign-wide loot planning.*

## Features

- **Cache Generator:** Terrain-aware, tier-scaled loot caches with a single click. Nine terrain
  themes, four party tiers, ten owner profiles. Full slot re-roll and preview before commit.
  Drag caches onto the canvas as interactive loot containers with [Item Piles](https://foundryvtt.com/packages/itempilesdnd5e).
- **Masked Items & Identification:** Generated items appear mundane to players — masked names,
  generic icons, concealed rarity. The GM reveals true identities with the identification wand.
- **Cursed Item Pool:** Seed your campaign with SRD cursed items that blend seamlessly into
  ordinary loot. Standalone management or full lifecycle integration with
  [Ionrift Cursewright](https://patreon.com/ionrift) (premium companion module).
- **Scroll Management:** Tagged spell scrolls with spell name, level, class hints, and party
  awareness. Scrolls the party already knows are deprioritised automatically.
- **Signature Ledger:** Campaign-length item distribution planner. Per-character timelines,
  party shelf, fairness tracking, and power-score monitoring.
- **Sonic Binding (Optional):** Bind Syrinscape sound effects to item actions.
  Requires `ionrift-resonance`.

## Installation

1. Install via the Foundry VTT Module Browser (search **Ionrift Quartermaster**).
2. Or via Manifest URL:
   `https://github.com/ionrift-gm/ionrift-quartermaster/releases/latest/download/module.json`

## Usage

- Click **Loot Cache** in the Items Directory header to generate terrain-aware loot.
- Click **Quartermaster** to open the Signature Ledger and campaign planner.
- Right-click any item, then **Edit in Quartermaster** to refine it.
- Open **Module Settings → Quartermaster** to configure loot sources, scroll jitter,
  magic frequency, and the cursed item pool.

## Dependencies

| Module | Required? | What it enables |
|--------|-----------|----------------|
| [`ionrift-library`](https://github.com/ionrift-gm/ionrift-library) v2.0.0+ | **Yes** | Core shared utilities |
| [`itempilesdnd5e`](https://foundryvtt.com/packages/itempilesdnd5e) | Recommended | Drag-to-canvas loot containers, player looting UI |
| [`ionrift-cursewright`](https://patreon.com/ionrift) | Optional | Full cursed item lifecycle — escalation, activation, narration |
| [`ionrift-resonance`](https://github.com/ionrift-gm/ionrift-resonance) | Optional | Sound effects bound to item actions |

## Documentation

Full guides on the **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)**:

- **[Setup: Quartermaster](https://github.com/ionrift-gm/ionrift-library/wiki/10-Setup-Quartermaster)** — Installation, cache generation, and first-time configuration
- **[Setup: Cursewright](https://github.com/ionrift-gm/ionrift-library/wiki/11-Setup-Cursewright)** — Cursed item lifecycle (premium companion)

## Bug Reports

1. Check the **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)** for common fixes.
2. Post to the **[Ionrift Discord](https://discord.gg/vFGXf7Fncj)** with your Foundry version,
   module versions, and any console errors (F12, Console tab).
3. Open a **[GitHub Issue](https://github.com/ionrift-gm/ionrift-quartermaster/issues)**.

## License

MIT License. See [LICENSE](./LICENSE) for details.

---

**Part of the [Ionrift Module Suite](https://github.com/ionrift-gm)**

[Wiki](https://github.com/ionrift-gm/ionrift-library/wiki) · [Discord](https://discord.gg/vFGXf7Fncj) · [Patreon](https://patreon.com/ionrift)
