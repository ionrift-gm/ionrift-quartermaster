# Changelog

## [1.4.0] - 2026-06-04

### Added
- **Quick setup profiles.** Low, Standard, and High loot presets in module settings. The confirm dialog groups loot and identification rows and highlights only the values that will change.
- **Ammunition type curve.** A new config panel lets you weight how often each ammo category (arrows, bolts, sling bullets, needles) appears in caches. Quick presets, per-type steppers, and a live distribution bar. Custom ammo types can be added with regex patterns.
- **Compendium Forge.** Unified compilation interface for loot pools, scroll sources, and cursed item pools. Each tab tracks its compiled state, shows freshness, and lets you clear and recompile in place.
- **Healing potion frequency.** A slider in loot generation settings controls how often consumable picks are healing potions, from basic through supreme.
- **Obscure magical items.** Identification settings can leave weapons and armor readable while consumables and scrolls stay masked.
- **GM setup guide.** A journal compendium linked from Quick Setup walks through cache generation, identification, and the Signature Ledger.

### Changed
- **Grouped settings panel.** Loot generation, identification, and progression each open in their own submenu instead of a single flat list.

### Fixed
- **Magical ammo pricing.** Stacked ammunition no longer multiplies its gp value twice (e.g. a stack of +1 arrows priced at thousands instead of dozens).
- **Coin vs item budget.** Rolled coin no longer spends the item budget before slots are filled, which caused gold-only Arcana caches at high tiers.
- **Scroll level reads.** Picks now use Scroll Forge metadata for spell circle instead of the template item level that often stayed at 1.


## [1.3.13] - 2026-05-28

### Added
- **Healing potion tiering.** Higher-tier caches now favour stronger healing potions instead of flooding every cache with basic healing.
- **Bulk provisions.** Cheap consumables like feed and ammunition now appear in realistic stacks of 10-50 rather than individual units. Rations and water stay in smaller stacks (about 2-10) and respect container weight.

### Fixed
- Terrain-bound items no longer appear in caches for other terrains. Items without a terrain tag remain available everywhere.
- Poison potions no longer surface from random cache rolls. They are GM-placed items only.
- Overlay gems, treasure, and trinkets no longer leak into the mundane trade-goods pool when their overlay packs are enabled.
- The core content pack nudge no longer fires when the overlay is already visible.

## [1.3.12] - 2026-05-26

### Changed
- Terrain data is plug-and-play. The module ships five base terrains; additional terrains now travel with their content overlays and register automatically when installed.
- The Cache Generator terrain picker is self-contained. It no longer reads terrain lists from other modules.

### Fixed
- Content overlays with nested folder layouts now materialise correctly. Previously the walker only scanned one level deep, so some overlays produced empty compendiums.
- Gems, treasure, and trinkets from content overlays now appear in the Cache Generator and render in their own sections.
- Bundled containers can no longer be hidden by an active content overlay.

### Removed
- Quiet notifications. Overlay rebuild toasts only fire when content actually changes, and cache drops no longer announce themselves.

## [1.3.11] - 2026-05-26

Superseded by 1.3.12 (changelog cleanup).

## [1.3.9] - 2026-05-25

### Added
- Cache generation favours terrain-specific containers. When a content pack ships containers tagged for the current terrain, those are preferred over generic fallbacks before the pool selects on owner theme and capacity.
- Cache discovery narration can now come from the container itself. Containers that ship with multiple paragraphs in their description provide one discovery line per cache; terrain-level phrases remain the fallback when a container has no narration of its own.

### Changed
- Container resolution now spans every materialised overlay pack that follows the `world.quartermaster-containers*` naming. Previously only the canonical pack was consulted, which excluded named drops.
- The bundled container compendium realigns its terrain tags with the released spine. Caches generated for catacombs, ruins, dungeon, and urban now reliably surface the matching bundled containers instead of falling through to the generic pool.
- The bundled compendium is now scoped to multi-terrain workhorses and universal containers. Single-terrain flavour pieces ship through content overlays so the base module stays compact and the spine terrains are the only ones the bundled pack is responsible for.

### Removed
- Two arctic/mountain containers (fur-wrapped pack, ironbound cold chest) no longer ship in the base module. Frost-and-stone terrain coverage moves to a dedicated content overlay; worlds without that overlay will fall back to the universal containers when arctic or mountain terrain is selected.

## [1.3.8] - 2026-05-24

### Added
- Cache Generator terrain dropdown is grouped into **Dungeon**, **Safe Haven**, and **Wilderness**, matching Respite.
- **Drag-and-drop to cache preview.** Items from compendiums or the world item sidebar can now be dropped directly onto the loot builder preview to inject them into the cache.
- **Coin reroll and clear.** The coinage row in the cache preview now has reroll and clear buttons, so you can re-randomise or zero out the gold without regenerating the whole cache.

### Fixed
- Item creation during cache generation no longer fails when the source item has an unexpected data shape. Guards added to the promotion and mint paths prevent silent drops.

### Added
- Loot pools now exclude Cursewright-managed compendiums automatically. If Cursewright handles injection for a source, it will not appear in the Quartermaster pool configuration.

### Changed
- The content nudge now uses the shared Ionrift Library banner. Your prior "snooze" or "don't show again" choices carry over.

### Fixed
- Caches now correctly discover compendiums delivered through content overlays. Previously the generator only looked up compendiums by their module-shipped ids and missed the world packs the overlay produced.
- Disabling a content pack in the Library now actually removes its items from newly generated caches. The pack's compendium stays on disk so any GM edits survive, but it is withdrawn from Loot Pool Sources on the next roll.
- Bulky low-value items can no longer dominate an entire cache. A cheap heavy item like a greatclub used to multiply itself into a 70 lb stack inside a 35 lb pack, leaving every other slot to backfill as coinage. Stacks are now capped against the bag's remaining capacity, and slot repicks consider the same budget so the cache stays varied even when space is tight.
- Cache previews no longer show stale terrain data after changing the active terrain in the same session.

## [1.3.4] - 2026-05-19

### Changed
- Item packs now reload automatically when content updates are applied.

## [1.3.3] - 2026-05-19

Build to support Foundry VTT package listing submission. No user-facing changes.



## [1.3.2] - 2026-05-18

General availability release. Quartermaster is now publicly listed in the Foundry VTT module browser.

### Added
- **Swamp and Arctic terrain themes.** Nine terrain types total, aligned with Respite.
- **Cursed item pool.** Seed caches with SRD cursed items that look like ordinary loot until triggered. Standalone, no companion module needed.
- **Identified-twin promotion.** Cursed weapons and armor now restore their full mechanical state on identification - damage formulas, attack activities, and magical bonuses are pulled from the compiled twin.
- **Stale UUID recovery.** Caches generated before a CurseForge recompile automatically remap to the correct items by name. Nothing breaks on recompile.
- **Potion enrichment.** Healing potions in caches reliably show charges, weight, and Consume activity in the player's inventory, including 2024 PHB variants.
- **Infected potion stacking.** Infection counts sum correctly when poisoned potions merge into an existing stack.

### Changed
- **All module settings are GM-only.** Cache generation parameters are restricted to the GM.
- **Cursed pool filters identified twins.** Only lure-form items appear in the pool; the GM-reference identified docs are excluded.
- **Requires Foundry v12+, verified on v14.**

### Fixed
- **Scroll level weighting.** Higher-tier caches now produce meaningfully higher-level scrolls.
- **Zero-data items excluded from loot pools.** Generic placeholder entries no longer enter the cache generator.
- **Forge import repaired.** The release archive no longer contains stale nested zips or duplicate manifests that caused the Forge import wizard to reject the package.
- **Party Shelf source picker.** Compendium types now filter correctly on cold-boot Forge installs.

## [1.3.2-ea.4] - 2026-05-18

### Fixed
- **Forge import no longer fails with "Could not find module manifest."** The release archive contained a stale zip from a previous build, causing The Forge to detect two nested modules and reject the inner one. The packaging pipeline now excludes leftover archives.

## [1.3.2-ea.3] - 2026-05-17

### Fixed
- **Containers compendium now ships populated.** The containers LDB was excluded from the release zip, leaving the pack empty on clean Forge installs and preventing any cache from being deployed to the canvas. All 18 containers now ship correctly.
- **Party Shelf source picker no longer lists non-equipment compendiums.** On The Forge, compendium indexes are lazy-loaded - the type filter was skipped entirely on a cold boot, causing class, monster, and feature packs to appear in the list. The picker now force-loads each index before filtering.
- **Clear advisory when Item Piles is not installed.** GMs opening a world without Item Piles installed now see a persistent notification explaining that canvas placement requires it, rather than a silent "No container matched" message.

## [1.3.2-ea.2] - 2026-05-17


### Added
- **Identified-twin promotion for cursed items.** When you identify a cursed weapon or piece of armor, the item now pulls its true mechanical state - name, damage formulas, magical bonus, activities, and properties - directly from the compiled twin rather than reconstructing it from flags. Cursed weapons like Oathcleaver now retain their full attack and damage activities after identification.
- **Stale UUID recovery.** If you recompile your cursed items through CurseForge, caches that were generated before the recompile no longer break. The system automatically resolves items by name when the original document ID is no longer valid.
- **Potion enrichment pipeline.** Healing potions placed in caches now reliably show their charges, weight, and "Consume" activity in the player's inventory - including 2024 PHB variants that shipped with blank consumable type data.
- **Infected potion stack merging.** When poisoned potions are identified and merged into an existing stack, the infection count is now properly summed onto the target. Previously the count was lost during merge.

### Changed
- **All module settings are now GM-only.** Loot Abundance, Magic Frequency, Obscure Consumables, and other configuration dials are restricted to the GM. Players can no longer change cache generation parameters.
- **Forged pool excludes identified twins.** The cursed pool now filters out the GM-reference "identified" docs that CurseForge emits alongside each lure. Only lure-form items appear in the pool.
- **Pool UUID rematch after recompile.** Recompiling cursed items through the Signature Ledger now automatically re-links any pool entries whose UUIDs became stale.

### Fixed
- **Scroll level weighting overhauled.** Higher-tier caches now produce meaningfully higher-level scrolls. The previous weighting formula bottlenecked at level 1 regardless of tier settings.
- **Zero-data placeholder items excluded from loot pools.** Generic placeholder entries (Belt of Giant Strength generic, Deck of Many Things cards, traps) are now filtered during pool seeding. Only items with real price/weight/rarity data enter the cache generator.
- **Cursed pool name resolution stabilised.** The pool display no longer shows raw compendium IDs or stale names after a CurseForge recompile.
- **Consumable activity data preserved.** Potions and scrolls no longer have their Consume/Cast activities stripped during the masking process.
- **Ammunition included in consumable pools.** Ammunition subtypes (arrows, bolts, etc.) are now eligible for cache generation.
- **Diagnostic console noise removed.** Development-only console.warn statements have been stripped from the production build.
- **Cursed item identification no longer wipes weapon damage.** The _applyRecipe pipeline now conditionally preserves activity data for weapons and armor.

## [1.3.2-ea.1] - 2026-05-09

### Added
- **Swamp and Arctic terrain themes.** The Cache Generator now includes Swamp and Arctic alongside the existing seven terrains, bringing the terrain list into alignment with Respite. Each has its own discovery flavour text and mastercraft material weighting.
- **Five new terrain containers.** Three for swamp (Tarred Reed Bundle, Clay-Sealed Urn, Waxed Leather Satchel) and two for arctic (Fur-Wrapped Pack, Ironbound Cold Chest). All five are terrain-tagged and will surface naturally when generating caches in those environments.
- **Standalone cursed item pool.** The Cursed Pool tab seeds from the SRD's 12 canonical cursed items with masked names and generic icons, indistinguishable from ordinary loot until triggered. No Proving Grounds content required.
- **Cursed item import picker.** GMs can browse any compendium and manually add items to the cursed pool, regardless of origin.

### Coming Up
- Curse mechanics are expanding. The standalone SRD pool ships now; a full companion module is in the works.

## [1.3.0-ea.2] - 2026-05-03

### Changed
- **Published bundle matches the shipped compendium set.** The install archive only includes the container compendium; Proving Grounds stays local until it is promoted for distribution.
- **One cursed-item compendium.** Ionrift originals and Proving Grounds items now live together under **Proving Grounds: Cursed Items**. The old **Quartermaster: Cursed Items** pack is removed so the sidebar is not duplicated. Worlds that still pointed at the old pack get their Cursed Pool setting and ledger UUIDs migrated automatically on next load.

## [1.3.0-ea.1] - 2026-05-03

### Changed
- Quartermaster now requires **ionrift-library 2.0.0** or later and resolves party members through the library party roster for the Signature Ledger.
- Swap-and-betrayal curse mechanics (`per-attack-swap`) ship from the **Proving Grounds** intervention bundle instead of living entirely inside the core engine. Other packs can register their own intervention types the same way later.

### Fixed
- EA fixes from **1.2.0-ea.6** and **1.2.0-ea.7** are merged into this library-aligned line so testers keep loot pool / scroll plan fixes while staying on current Ionrift Library.

## [1.2.0-ea.7] - 2026-04-24

### Fixed
- **Loot Pool Sources dialog scrolls properly.** GMs with many compendiums installed no longer see a clipped, unscrollable list. The dialog now has a fixed height with an inner scroll area — all sources are visible and reachable.
- **Pinned scrolls can be placed in all three Scroll Plan rows.** The bottom row of each milestone column was silently rejecting drops. All three slots per milestone are now fully functional for drag-and-drop placement and swapping.
- **Scrollbar theming on source dialogs.** Foundry's default red scrollbar is overridden with the Ionrift purple theme across all source-picker windows.

## [1.2.0-ea.6] - 2026-04-21

### Added
- **Curse Engine.** Cursed item injection is now live - the GM can seed caches with cursed variants that reveal themselves on use. A dedicated Cursed Items compendium ships with the module.
- **Milestone Profiles.** Five campaign presets (Full 1-20, Tier 2, Tier 3, Chapter 1, Chapter 2) replace the old hardcoded milestone levels. Switch profiles in Settings and the Signature Ledger updates immediately.
- **Scarcity UX.** The Signature Ledger now explains its budget philosophy up front with a description block, budget pips per character, and a footer note.
- **Lock icon on budget-full slots.** Slots that have reached their budget cap show a lock instead of an empty drop target.

### Changed
- **Power deviation uses maximum score as baseline.** Deviation is now measured against the strongest party member rather than the average. The raw power score is available in the tooltip.
- **Button height and radius aligned** across Cache Generator, Scroll Plan, and Party Shelf tabs.

### Fixed
- Scroll Forge scrolls now have a proper "Cast" activity and function when used by players.
- Delivered signature items no longer appear as suggestions in the cache generator advisory.
- Power score no longer returns 0 for characters with magic items that lack a non-common rarity. Detection now uses the dnd5e `mgc` property and covers weapons, equipment, tools, and containers.
- Signature Ledger party manager changes now take effect immediately. Profile changes trigger a live UI refresh.
- Scroll Forge deduplication docs updated to clarify first-seen-wins behaviour across overlapping compendiums.

### Known Issues
- Containers compendium may appear empty on first install. This is a LevelDB distribution issue, not a data bug. Reinstalling the module resolves it.

## [1.2.0-ea.5] - 2026-04-20

### Changed
- Platform logic (Forge detection, FilePicker resolution, directory creation) now delegates to the ionrift-library kernel instead of carrying local copies. No user-facing changes - this is a maintenance update that requires ionrift-library 1.9.0 or later.

## [1.2.0-ea.4] - 2026-04-19

### Fixed

- **Power score replaces the legacy RVP display.** The "RVP" label that showed 0 for all characters is gone. The Signature Ledger now shows a live power score derived from each character's current inventory, with a colour-coded bar and deviation label.
- **"Fill with suggestions" no longer locks Signature Ledger slots.** Auto-filled slots were incorrectly marked as disabled, preventing item drops. Filled slots now always accept replacements regardless of budget state.
- **Party Shelf "Randomise" actually cycles suggestions.** Previously, rerolling kept old auto-generated items and only added new ones. It now strips previous suggestions while preserving anything you manually placed or locked.
- **Party Shelf copy rewritten for clarity.** Hint text and footer notes now explain planned vs randomised items and what survives a reroll.
- **Under-equipped warning uses power score instead of RVP.** The per-character banner now reads relative power deviation instead of a static deficit number that was always zero.

## [1.2.0-ea.3] - 2026-04-18

### Fixed

- **Scroll Forge now handles 3rd-party spell compendiums.** Spells from modules like Chris's Premades and Conflux previously crashed the compile. They now fall back gracefully — any spells that can't produce a native scroll are built manually, and the compile continues. A skip count appears in the notification if any were skipped.
- **Loot Pool Sources dialog is fully functional.** The compendium picker can now scroll, expand and collapse module groups, and no longer overlaps text. Both the Loot Pool and Scroll Forge source dialogs received a complete visual pass.
- **Empty spell scroll folders no longer appear** after a partial compile failure. The root cause — a single unrecognised spell aborting the entire batch — is resolved.

## [1.2.0-ea.2] - 2026-04-17

### Fixed

- Module download URL now points to the correct release artifact. Direct installs via the Foundry package manager work again.

## [1.2.0-ea.1] - 2026-04-17

### Added

- **Gemstone & Treasure Content Pack** — 39 gemstones and 40 treasure items with original Ionrift icons, integrated into cache generation pools.
- Compendium packs now ship with the module: core items, gemstones, containers, and treasure.

### Changed

- Upgraded to ionrift-library v1.8.0 dependency.

### Fixed

- Template partials (`slot-cell.hbs`) now load reliably on hosted platforms like The Forge.

## [1.1.0-ea.1] - 2026-04-16

### Early Access Release

First early access build of the Ionrift Quartermaster. Available to Acolyte-tier patrons.

### Features

- **Cache Generator** — Terrain-aware loot cache generation with 5 cache types (Mundane, Consumable, Mastercraft, Scroll, Signature), 7 terrain themes, and 4 party tiers. GP budget scaling, randomised coinage distribution, and per-slot re-roll.
- **Scroll Forge** — Runtime scroll builder that reads installed spell compendiums and constructs scroll items. Configurable spell sources, level jitter, and party-aware level caps. Eliminates SRD scroll redistribution.
- **Signature Ledger** — Per-character milestone timeline for planning campaign signature items. Drag-to-place from compendiums, delivery tracking, power score heuristics, and RVP fairness signals.
- **Scroll Plan** — Milestone-based scroll placement board with pinned scrolls that bypass jitter. Party median level band with reach visualisation.
- **Party Shelf** — Party-wide item planning board. Randomise from configured compendiums or manually pin items to milestones. Auto-delivery detection from party inventories.
- **Ban List** — Exclude specific items from all cache generation. Drag from compendiums or the sidebar.
- **Progression Advisory** — Power score deviation tracking, disparity flagging, and per-character budget pips.
- **Loot Pool Configuration** — Choose which compendiums contribute items to the cache generator. Defaults to SRD system packs.
- **Loot Abundance and Magic Frequency** — Global dials for cache value scaling and magical item probability.
- **Spike Tolerance** — Controls how much loot timing can deviate from planned milestones (Strict / Flexible / Wild).

### Infrastructure

- CI pipeline with ESLint v9 (50 warning budget) and artifact hygiene gate.
- Pre-release gate workflow for manual validation.
- Ionrift Library dependency for CloudRelay and settings infrastructure.

### Known Limitations

- Compendium packs (core items, gemstones, containers, treasure) are not included in this EA build. The cache generator uses SRD system packs as default sources.
- ~~Curse Engine is present in the codebase but all user-facing surfaces are hidden.~~ Shipped in v1.2.0-ea.6.
- ~~Bulk trade goods (items under 1 gp) produce quantity 1. A price-based heuristic for bulk quantities is planned.~~ Fixed in v1.3.13.
