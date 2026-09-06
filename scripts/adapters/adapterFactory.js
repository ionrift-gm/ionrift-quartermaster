import { DnD5eItemAdapter } from "./concrete/dnd/DnD5eItemAdapter.js";
import { PF2eItemAdapter } from "./concrete/pathfinder/PF2eItemAdapter.js";
import { GenericItemAdapter } from "./concrete/generic/GenericItemAdapter.js";
import { Logger, MODULE_LABEL } from "../utils/Logger.js";

/** @returns {import("./QuartermasterItemAdapter.js").QuartermasterItemAdapter} */
export function createQuartermasterAdapter() {
    const systemId = game.system?.id ?? "unknown";

    switch (systemId) {
        case "dnd5e":
            return new DnD5eItemAdapter();
        case "pf2e":
        case "sf2e":
            return new PF2eItemAdapter();
        default:
            Logger.warn(
                MODULE_LABEL,
                `No dedicated Quartermaster adapter for "${systemId}". ` +
                `Using generic adapter (loot caches only, no scrolls/curses/masking).`
            );
            return new GenericItemAdapter(systemId);
    }
}
