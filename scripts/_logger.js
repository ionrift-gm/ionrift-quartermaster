/**
 * Local Logger proxy for ionrift-quartermaster.
 * Routes through the kernel Logger factory when available,
 * falls back to console with the correct prefix.
 */
const MODULE_LABEL = "Quartermaster";

const Logger = game.ionrift?.library?.createLogger?.(MODULE_LABEL) ?? {
    log() {},
    info(mod, ...a) { console.log(`Ionrift ${mod} |`, ...a); },
    warn(mod, ...a) { console.warn(`Ionrift ${mod} |`, ...a); },
    error(mod, ...a) { console.error(`Ionrift ${mod} |`, ...a); }
};

export { Logger, MODULE_LABEL };
