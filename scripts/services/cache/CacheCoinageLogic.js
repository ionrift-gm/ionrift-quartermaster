import { MODULE_ID } from "../../data/moduleId.js";

export class CacheCoinageLogic {

    /** Remove all coinage from a cache preview without touching items. */
    static clearCacheGold(cacheResult) {
        if (!cacheResult) return;
        cacheResult.gold = 0;
        if (cacheResult.meta) cacheResult.meta.preFloorGold = 0;
        delete cacheResult.coinage;
    }

    /**
     * Reconcile rolled coin with the cache budget floor after the GM changes
     * the budget bracket. Uses {@link meta.preFloorGold} so floor padding can
     * be added or removed without a full regen.
     *
     * @param {Object} cacheResult
     * @param {number} [budgetMin=0]
     * @param {number|null} [budgetMax]
     * @returns {Object}
     */
    static applyBudgetFloor(cacheResult, budgetMin = 0, budgetMax = null) {
        if (!cacheResult) return cacheResult;

        const floor = Math.max(0, Number(budgetMin) || 0);
        const preFloor = cacheResult.meta?.preFloorGold ?? cacheResult.gold ?? 0;
        const itemValue = (cacheResult.items ?? []).reduce(
            (sum, item) => sum + (item.price ?? 0),
            0
        );

        let gold = preFloor;
        if (floor > 0 && preFloor + itemValue < floor) {
            gold = floor - itemValue;
        }

        cacheResult.gold = Math.max(0, Math.round(gold));
        if (cacheResult.meta) {
            cacheResult.meta.budgetMin = floor;
            if (budgetMax !== null && budgetMax !== undefined) {
                cacheResult.meta.budgetMax = budgetMax;
            }
        }
        this._syncCacheCoinage(cacheResult);
        return cacheResult;
    }

    /** Refresh or clear distributed coin breakdown for a cache preview. */
    static _syncCacheCoinage(cacheResult) {
        if (!cacheResult) return;
        if (cacheResult.gold > 0 && game.settings.get(MODULE_ID, "distributeCoins") !== false) {
            cacheResult.coinage = this._distributeCoinage(cacheResult.gold);
        } else {
            delete cacheResult.coinage;
        }
    }

    /**
     * Splits a raw GP value into a randomized mix of standard 5e coin denominations.
     */
    static _distributeCoinage(totalGp) {
        if (!totalGp || totalGp <= 0) return null;

        let remainingCp = Math.floor(totalGp * 100);
        const coins = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };

        // 1. PP alloc (only sometimes when large enough)
        if (remainingCp >= 1000 && Math.random() < 0.6) {
            const maxPp = Math.floor(remainingCp / 1000);
            const ppAlloc = Math.floor(maxPp * (0.1 + Math.random() * 0.4));
            coins.pp = ppAlloc;
            remainingCp -= (ppAlloc * 1000);
        }

        // 2. EP alloc (rarely, small amounts)
        if (remainingCp >= 50 && Math.random() < 0.2) {
            const epAlloc = Math.floor(Math.random() * 10) + 1;
            const cost = epAlloc * 50;
            if (cost <= remainingCp * 0.2) {
                coins.ep = epAlloc;
                remainingCp -= cost;
            }
        }

        // 3. SP and CP (small handfuls)
        const spAlloc = Math.floor(Math.random() * 50);
        if (spAlloc * 10 <= remainingCp * 0.2) {
            coins.sp = spAlloc;
            remainingCp -= spAlloc * 10;
        }

        const cpAlloc = Math.floor(Math.random() * 100);
        if (cpAlloc <= remainingCp * 0.1) {
            coins.cp = cpAlloc;
            remainingCp -= cpAlloc;
        }

        // 4. GP takes the bulk
        const gpAlloc = Math.floor(remainingCp / 100);
        coins.gp = gpAlloc;
        remainingCp -= (gpAlloc * 100);

        // Dump absolute remainder into SP/CP
        if (remainingCp >= 10) {
            const extraSp = Math.floor(remainingCp / 10);
            coins.sp += extraSp;
            remainingCp -= extraSp * 10;
        }
        if (remainingCp > 0) {
            coins.cp += remainingCp;
        }

        for (const k of Object.keys(coins)) {
            if (coins[k] === 0) delete coins[k];
        }

        return Object.keys(coins).length > 0 ? coins : null;
    }
}
