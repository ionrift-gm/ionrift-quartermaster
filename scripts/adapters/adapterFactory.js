import { DnD5eItemAdapter } from "./DnD5eItemAdapter.js";
import { PF2eItemAdapter } from "./PF2eItemAdapter.js";
import { Logger, MODULE_LABEL } from "../_logger.js";

/**
 * @returns {import("./QuartermasterItemAdapter.js").QuartermasterItemAdapter}
 */
export function createQuartermasterAdapter() {
    const systemId = game.system?.id ?? "unknown";

    switch (systemId) {
        case "dnd5e":
            return new DnD5eItemAdapter();
        case "pf2e":
            return new PF2eItemAdapter();
        default:
            Logger.warn(
                MODULE_LABEL,
                `No Quartermaster adapter for system "${systemId}"; using DnD5e pass-through.`
            );
            return new DnD5eItemAdapter();
    }
}
