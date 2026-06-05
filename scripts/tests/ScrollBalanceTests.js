/**
 * Live scroll balance suite entry point. Invoked from ionrift-devtools only.
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
