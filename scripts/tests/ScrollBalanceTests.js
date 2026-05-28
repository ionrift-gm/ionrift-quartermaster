/**
 * Foundry test harness: empirical scroll balance on the live forged pack.
 * Register via ionrift-library tests panel.
 */

import { runLiveScrollBalanceSuite } from "../services/ScrollBalanceSimulator.js";

export async function runScrollBalanceTests() {
    try {
        return await runLiveScrollBalanceSuite();
    } catch (e) {
        return {
            passed: 0,
            failed: 1,
            total: 1,
            results: [{
                name: "scroll-balance-harness",
                status: "fail",
                message: e.message
            }]
        };
    }
}
