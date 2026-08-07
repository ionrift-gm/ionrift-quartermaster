/**
 * Register Quartermaster Russian Babele pack translations when Babele loads.
 */
Hooks.once("babele.init", (babele) => {
    babele.register({
        module: "ionrift-quartermaster",
        lang: "ru",
        dir: "babele/ru"
    });
});
