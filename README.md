# Ionrift Quartermaster

![Downloads](https://img.shields.io/github/downloads/ionrift-gm/ionrift-quartermaster/total?color=violet&label=Downloads)
![Latest Release](https://img.shields.io/github/v/release/ionrift-gm/ionrift-quartermaster?color=violet&label=Latest%20Version)
![Foundry v12+](https://img.shields.io/badge/Foundry-v12%2B-333333?style=flat&logo=foundryvirtualtabletop)
![Systems](https://img.shields.io/badge/system-dnd5e-blue)

> **The GM's loot engine for Foundry VTT. Terrain-aware cache generation, scroll management,
> cursed item tracking, and campaign item planning.**

> Documentation, setup guides, and troubleshooting: **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)**

## Features

- **Cache Generator:** Terrain-aware, tier-scaled loot caches with a single click. Nine terrain
  themes, four party tiers, ten owner profiles. Full slot re-roll and preview before commit.
- **Cursed Item Pool:** Seed your campaign with SRD cursed items that are indistinguishable from
  ordinary loot: masked names, generic icons, concealed rarity. GM-only pool with standalone
  management or full integration with Cursewright (premium companion module).
- **Scroll Management:** Tagged spell scrolls with spell name, level, class hints, and party
  awareness. Scrolls the party already knows are deprioritised automatically.
- **Signature Ledger:** Campaign-length item distribution planner. Per-character timelines,
  party shelf, fairness tracking, power-score monitoring.
- **Item Forge:** Focused UI for creating and editing items outside the sidebar clutter.
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

- [`ionrift-library`](https://github.com/ionrift-gm/ionrift-library) v2.0.0+ (Required)
- [`ionrift-resonance`](https://github.com/ionrift-gm/ionrift-resonance) (Optional, Sound Binding)

## Bug Reports

1. Check the **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)** for common fixes.
2. Post to the **[Ionrift Discord](https://discord.gg/vFGXf7Fncj)** with your Foundry version,
   module versions, and any console errors (F12, Console tab).
3. Open a **[GitHub Issue](https://github.com/ionrift-gm/ionrift-quartermaster/issues)**.

## License

This module is released under a custom Ionrift licence. Personal use in Foundry VTT games is
permitted. Source code redistribution or derivative public releases are not permitted without
written permission. See `LICENSE` for full terms.

---

**Part of the [Ionrift Module Suite](https://github.com/ionrift-gm)**

[Wiki](https://github.com/ionrift-gm/ionrift-library/wiki) · [Discord](https://discord.gg/vFGXf7Fncj) · [Patreon](https://patreon.com/ionrift)
