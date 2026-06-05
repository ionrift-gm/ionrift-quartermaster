/**
 * LootPoolAuditor
 *
 * Classifies compendium rows by economy completeness and compiler coverage.
 * Run from Foundry (console or ionrift_debug macro) before extending
 * LootPoolCompiler manifests.
 */

import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { LootPoolCompiler } from "./LootPoolCompiler.js";
import { PotionEnrichment } from "./PotionEnrichment.js";
import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";

/** @typedef {"A_template"|"B_economy_pending"|"C_loot_ready"|"excluded"|"other"} LootBucket */

export class LootPoolAuditor {

    /**
     * Scan enabled loot pool sources and return a structured audit report.
     *
     * @param {object} [opts]
     * @param {string[]} [opts.sourceIds] Override lootPoolSources (default: enabled set)
     * @param {boolean} [opts.includeCompiledPool=true] Cross-check world compiled pack
     * @returns {Promise<object>}
     */
    static async audit(opts = {}) {
        const sourceIds = opts.sourceIds ?? ItemPoolResolver.getEnabledSources();
        const manifest = LootPoolCompiler.getCompilerManifest();
        const byBucket = {
            A_template: [],
            B_economy_pending: [],
            C_loot_ready: [],
            excluded: [],
            other: []
        };
        const byPack = {};
        let totalRows = 0;

        for (const packId of sourceIds) {
            if (packId === LootPoolCompiler.worldCollectionId) continue;

            const pack = game?.packs?.get(packId);
            if (!pack || pack.documentName !== "Item") continue;

            const rows = [];
            try {
                const index = await pack.getIndex({
                    fields: [
                        "name", "type", "system.price", "system.rarity",
                        "system.type", "system.weight", "system.description"
                    ]
                });
                for (const entry of index) {
                    totalRows++;
                    const row = this.classifyEntry(entry, { packId, manifest });
                    rows.push(row);
                    byBucket[row.bucket].push(row);
                }
            } catch (err) {
                Logger.warn(MODULE_LABEL, `LootPoolAuditor: index failed for ${packId}:`, err.message);
            }
            byPack[packId] = rows;
        }

        const manifestGaps = this._findManifestGaps(manifest, byPack);
        let compiledSummary = null;

        if (opts.includeCompiledPool !== false) {
            compiledSummary = await this._summarizeCompiledPool(manifest);
        }

        return {
            scannedAt: new Date().toISOString(),
            sourceIds,
            totalRows,
            manifest,
            manifestGaps,
            compiledSummary,
            byBucket,
            byPack,
            counts: Object.fromEntries(
                Object.entries(byBucket).map(([key, arr]) => [key, arr.length])
            )
        };
    }

    /**
     * Classify one compendium index entry.
     *
     * @param {object} entry
     * @param {object} [ctx]
     * @param {string} [ctx.packId]
     * @param {object} [ctx.manifest]
     * @returns {object}
     */
    static classifyEntry(entry, ctx = {}) {
        const name = (entry.name ?? "").trim();
        const packId = ctx.packId ?? entry._sourceCollection ?? "";
        const price = ItemPoolResolver._extractPrice(entry);
        const weight = ItemPoolResolver._extractWeight(entry);
        const rarity = (entry.system?.rarity ?? "").trim();
        const subtype = (entry.system?.type?.value ?? "").trim();
        const type = entry.type ?? "";
        const manifest = ctx.manifest ?? LootPoolCompiler.getCompilerManifest();

        const base = {
            name,
            packId,
            type,
            subtype,
            rarity: rarity || "(none)",
            price,
            weight,
            compendiumId: entry._id ?? entry.id ?? ""
        };

        if (this._isEconomyPending(entry, price, weight, rarity)) {
            return {
                ...base,
                bucket: "B_economy_pending",
                reason: "magical_rarity_zero_economy",
                compilerAction: manifest.namedEconomyEnrichment.includes(name)
                    ? "enrich_via_compiler"
                    : "add_to_enrichment_manifest"
            };
        }

        if (ItemPoolResolver._isExcluded(entry)) {
            const reason = this._exclusionReason(entry);
            const bucket = reason.startsWith("template") || reason.startsWith("zero_data")
                ? "A_template"
                : "excluded";
            return {
                ...base,
                bucket,
                reason,
                compilerAction: bucket === "A_template"
                    ? this._compilerActionFor(name, manifest)
                    : null
            };
        }

        if (price > 0 || weight > 0) {
            return {
                ...base,
                bucket: "C_loot_ready",
                reason: "economy_present",
                compilerAction: null
            };
        }

        return {
            ...base,
            bucket: "other",
            reason: "zero_economy_non_magical_or_edge",
            compilerAction: null
        };
    }

    /**
     * Print a human-readable summary to the console.
     *
     * @param {object} report
     */
    static printReport(report) {
        const lines = [];
        lines.push("=== Quartermaster Loot Pool Economy Audit ===");
        lines.push(`Sources: ${report.sourceIds.join(", ") || "(none)"}`);
        lines.push(`Rows scanned: ${report.totalRows}`);
        lines.push(`Counts: ${JSON.stringify(report.counts)}`);

        if (report.manifestGaps.missingInSources.length) {
            lines.push("\n-- Compiler manifest: missing from sources --");
            for (const name of report.manifestGaps.missingInSources) {
                lines.push(`  - ${name}`);
            }
        }

        if (report.manifestGaps.unmanifestedTemplates.length) {
            lines.push("\n-- Template shells in sources, not in compiler manifest --");
            for (const row of report.manifestGaps.unmanifestedTemplates.slice(0, 40)) {
                lines.push(`  - [${row.packId}] ${row.name} (${row.reason})`);
            }
            if (report.manifestGaps.unmanifestedTemplates.length > 40) {
                lines.push(`  ... +${report.manifestGaps.unmanifestedTemplates.length - 40} more`);
            }
        }

        if (report.byBucket.B_economy_pending.length) {
            lines.push("\n-- Bucket B: economy pending (0/0, magical rarity) --");
            for (const row of report.byBucket.B_economy_pending.slice(0, 30)) {
                lines.push(`  - [${row.packId}] ${row.name} (${row.rarity}) → ${row.compilerAction}`);
            }
            if (report.byBucket.B_economy_pending.length > 30) {
                lines.push(`  ... +${report.byBucket.B_economy_pending.length - 30} more`);
            }
        }

        if (report.compiledSummary) {
            lines.push("\n-- Compiled pool --");
            lines.push(`  items: ${report.compiledSummary.itemCount ?? "?"}`);
            lines.push(`  version: ${report.compiledSummary.compilerVersion ?? "?"}`);
            lines.push(`  expected outputs present: ${report.compiledSummary.present}/${report.compiledSummary.expected}`);
            if (report.compiledSummary.missingSamples.length) {
                lines.push("  missing samples:");
                for (const name of report.compiledSummary.missingSamples) {
                    lines.push(`    - ${name}`);
                }
            }
        }

        const text = lines.join("\n");
        console.log(text);
        return text;
    }

    // ── Internal ───────────────────────────────────────────────────────────

    static _isEconomyPending(entry, price, weight, rarity) {
        if (price !== 0 || weight !== 0) return false;
        if (PotionEnrichment.isHealingPotion(entry.name)) return false;
        const effective = (rarity ?? "").trim().toLowerCase();
        if (!effective || effective === "common" || effective === "none") return false;
        return true;
    }

    static _exclusionReason(entry) {
        if (ItemPoolResolver._isPlaceholderPoolEntry(entry)) return "placeholder_pool_entry";
        if (ItemPoolResolver._isZeroDataPlaceholder(entry)) return "zero_data_shell";
        if (ItemPoolResolver._isZeroWeightWeaponTemplate(entry)) return "template_weapon_shell";
        if (ItemPoolResolver._isZeroWeightArmorTemplate(entry)) return "template_armor_shell";
        if (ItemPoolResolver._isTrapOrHazard(entry)) return "trap_or_hazard";
        if (ItemPoolResolver._isBulkAmmoCollection(entry)) return "bulk_ammo";
        if (ItemPoolResolver._isGmPlacedPoison(entry)) return "gm_placed_poison";
        if (ItemPoolResolver._isLegacyRenamedItem(entry)) return "legacy_renamed";
        if (ItemPoolResolver._isContainerContentOnly(entry)) return "container_content_only";
        if (ItemPoolResolver._isEconomyPendingLoot(entry)) return "economy_pending_hold";
        return "excluded_other";
    }

    static _compilerActionFor(name, manifest) {
        const key = name.trim();
        if (manifest.wondrousTemplates.includes(key)) return "expand_wondrous_template";
        if (manifest.slayingAmmoTemplate === key) return "expand_slaying_ammo";
        if (manifest.weaponTemplates.includes(key)) return "expand_weapon_template";
        if (manifest.armorTemplateShells.includes(key)) return "expand_armor_template";
        if (manifest.rangeStubs.includes(key)) return "expand_range_stub";
        if (/,\s*\+1,\s*\+2,\s*or\s*\+3/i.test(key)) return "add_compiler_manifest";
        return "review_for_compiler_manifest";
    }

    static _findManifestGaps(manifest, byPack) {
        const namesInSources = new Set();
        const templateRows = [];

        for (const rows of Object.values(byPack)) {
            for (const row of rows) {
                if (row.name) namesInSources.add(row.name.trim().toLowerCase());
                if (row.bucket === "A_template" && row.compilerAction === "review_for_compiler_manifest") {
                    templateRows.push(row);
                }
            }
        }

        const allManifestNames = [
            ...manifest.weaponTemplates,
            ...manifest.armorTemplateShells,
            ...manifest.wondrousTemplates,
            ...manifest.rangeStubs
        ];

        const missingInSources = allManifestNames.filter(
            name => !namesInSources.has(name.trim().toLowerCase())
        );

        return { missingInSources, unmanifestedTemplates: templateRows };
    }

    static async _summarizeCompiledPool(manifest) {
        const pack = game?.packs?.get(LootPoolCompiler.worldCollectionId);
        if (!pack) {
            return { itemCount: 0, compilerVersion: null, present: 0, expected: 0, missingSamples: [] };
        }

        let meta = null;
        try {
            meta = LootPoolCompiler.getCompiledMeta();
        } catch {
            meta = null;
        }

        const expectedNames = [
            "Dragon Slayer Longsword +1",
            "Belt of Hill Giant Strength",
            "Helm of Brilliance"
        ];

        let present = 0;
        const missingSamples = [];
        try {
            const index = await pack.getIndex({ fields: ["name"] });
            const compiled = new Set(
                (index.contents ?? Array.from(index)).map(e => (e.name ?? "").trim().toLowerCase())
            );
            for (const name of expectedNames) {
                if (compiled.has(name.toLowerCase())) present++;
                else missingSamples.push(name);
            }
            return {
                itemCount: compiled.size,
                compilerVersion: meta?.compilerVersion ?? null,
                present,
                expected: expectedNames.length,
                missingSamples
            };
        } catch {
            return {
                itemCount: meta?.itemCount ?? null,
                compilerVersion: meta?.compilerVersion ?? null,
                present: 0,
                expected: expectedNames.length,
                missingSamples: expectedNames
            };
        }
    }
}

export const __testables__ = {
    classifyEntry: (entry, ctx) => LootPoolAuditor.classifyEntry(entry, ctx)
};
