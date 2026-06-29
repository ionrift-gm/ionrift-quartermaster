import { createQuartermasterAdapter } from "./adapterFactory.js";

let _cached = null;

/**
 * Active Quartermaster system adapter. Prefer the instance on
 * game.ionrift.quartermaster.adapter when the module has finished init.
 *
 * @returns {import("./QuartermasterItemAdapter.js").QuartermasterItemAdapter}
 */
export function getQuartermasterAdapter() {
    if (game.ionrift?.quartermaster?.adapter) {
        return game.ionrift.quartermaster.adapter;
    }
    if (!_cached) {
        _cached = createQuartermasterAdapter();
    }
    return _cached;
}

/** @internal Test hook */
export function resetQuartermasterAdapterCache() {
    _cached = null;
}
