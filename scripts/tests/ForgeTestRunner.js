export class QuartermasterForgeTestRunner {
    static async runAll() {
        const results = [];
        let passed = 0;
        let failed = 0;

        // 1. Partial registration
        try {
            const expected = [
                "modules/ionrift-quartermaster/templates/partials/slot-cell",
                "modules/ionrift-quartermaster/templates/partials/sound-picker-row",
                "modules/ionrift-quartermaster/templates/scroll-forge-sources"
            ];

            const missing = expected.filter(key => !Handlebars.partials[key]);

            if (missing.length === 0) {
                passed++;
                results.push({
                    name: "Partial registration",
                    status: "pass",
                    message: `All ${expected.length} Quartermaster partials registered`
                });
            } else {
                failed++;
                results.push({
                    name: "Partial registration",
                    status: "fail",
                    message: `Missing partials: ${missing.join(", ")}`
                });
            }
        } catch (err) {
            failed++;
            results.push({
                name: "Partial registration",
                status: "fail",
                message: err.message
            });
        }

        return { passed, failed, total: passed + failed, results };
    }
}
