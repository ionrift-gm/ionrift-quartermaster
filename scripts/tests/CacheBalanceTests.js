/**
 * Live cache balance suite entry point. Invoked from ionrift-devtools only.
 */

import {
    runLiveCacheBalanceSuite,
    runLiveSettingsMatrixSuite
} from "../services/CacheBalanceSimulator.js";

export async function runCacheBalanceTests() {
    try {
        return await runLiveCacheBalanceSuite();
    } catch (e) {
        return {
            passed: 0,
            failed: 1,
            total: 1,
            results: [{
                name: "cache-balance-harness",
                status: "fail",
                message: e.message
            }]
        };
    }
}

/**
 * Live settings matrix: applies each QM loot profile in sequence, validates, continues.
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function runCacheBalanceSettingsMatrixTests(opts = {}) {
    try {
        const matrix = await runLiveSettingsMatrixSuite(opts);
        const results = [
            ...matrix.results.map(row => ({
                name: `${row.name} (live settings)`,
                status: row.status,
                message: row.message
            })),
            ...(matrix.orderingResults ?? []).map(row => ({
                name: `ordering:${row.id}`,
                status: row.status,
                message: row.message
            }))
        ];
        return {
            passed: matrix.passed,
            failed: matrix.failed,
            total: matrix.total,
            scenarioTotal: matrix.scenarioTotal,
            orderingTotal: matrix.orderingTotal,
            results
        };
    } catch (e) {
        return {
            passed: 0,
            failed: 1,
            total: 1,
            results: [{
                name: "cache-balance-settings-matrix",
                status: "fail",
                message: e.message
            }]
        };
    }
}
