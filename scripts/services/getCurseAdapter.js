import { SrdCurseAdapter } from "./SrdCurseAdapter.js";
import { Pf2eCurseAdapter } from "./Pf2eCurseAdapter.js";

/**
 * Active system curse compiler (dnd5e manifest vs PF2e-family trait scan).
 * Both write to world.ionrift-srd-cursed.
 * @returns {typeof SrdCurseAdapter | typeof Pf2eCurseAdapter}
 */
export function getCurseAdapter() {
    const id = game.system?.id ?? "dnd5e";
    if (id === "pf2e" || id === "sf2e") return Pf2eCurseAdapter;
    return SrdCurseAdapter;
}
