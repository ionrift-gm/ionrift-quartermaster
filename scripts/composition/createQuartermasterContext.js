import { WorkshopItemFactory } from "../services/WorkshopItemFactory.js";
import { CacheGenerator } from "../services/CacheGenerator.js";
import { SignatureLedger } from "../services/SignatureLedger.js";
import { ProgressionSeeder } from "../services/ProgressionSeeder.js";
import { ProgressionAdvisor } from "../services/ProgressionAdvisor.js";
import { ScrollForge } from "../services/ScrollForge.js";
import { createQuartermasterAdapter } from "../adapters/adapterFactory.js";
import { QM_FEATURES } from "../data/QMFeatures.js";
import { MODULE_ID, MODULE_LABEL } from "../data/moduleId.js";
import { Logger } from "../utils/Logger.js";

/**
 * Build the Quartermaster runtime bag (adapter + class surface).
 * Hooks and settings stay in module.js.
 */
export function createQuartermasterContext() {
    const adapter = createQuartermasterAdapter();

    const ctx = {
        MODULE_ID,
        MODULE_LABEL,
        adapter,
        features: QM_FEATURES,
        items: WorkshopItemFactory,
        cache: CacheGenerator,
        ledger: SignatureLedger,
        seeder: ProgressionSeeder,
        advisor: ProgressionAdvisor,
        scrollForge: ScrollForge
    };

    exposeQuartermasterApi(ctx);
    return ctx;
}

export function exposeQuartermasterApi(ctx) {
    game.ionrift = game.ionrift ?? {};
    game.ionrift.quartermaster = {
        ...(game.ionrift.quartermaster || {}),
        adapter: ctx.adapter,
        features: ctx.features,
        items: ctx.items,
        cache: ctx.cache,
        ledger: ctx.ledger,
        seeder: ctx.seeder,
        advisor: ctx.advisor,
        scrollForge: ctx.scrollForge
    };

    if (!ctx.adapter.supports(QM_FEATURES.LOOT_CACHE)) {
        Logger.warn(
            MODULE_LABEL,
            `System '${ctx.adapter.id}' has limited Quartermaster support. ` +
            `Loot cache and compendium compile features may be unavailable.`
        );
    }
}

export function getQuartermaster() {
    return game.ionrift?.quartermaster ?? null;
}

export function getAdapter() {
    return game.ionrift?.quartermaster?.adapter ?? null;
}
