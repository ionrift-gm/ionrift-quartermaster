/**
 * Quartermaster feature IDs for adapter capability gating.
 * Library-owned IDs (scroll-forge, srd-curses, signature-items, workshop)
 * are declared on IonriftSystemAdapter subclasses in ionrift-library.
 */
export const QM_FEATURES = Object.freeze({
    LOOT_CACHE:        "qm-loot-cache",
    LOOT_POOL_COMPILE: "qm-loot-pool-compile",
    SCROLL_FORGE:      "scroll-forge",
    SRD_CURSES:        "srd-curses",
    SIGNATURE_LEDGER:  "signature-items",
    WORKSHOP:          "workshop",
    LATENT_MASKING:    "qm-latent-masking",
});
