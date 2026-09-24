import { MODULE_LABEL } from "../data/moduleId.js";

function verbose() {
    try {
        const bag = game.settings?.settings;
        if (!bag?.has("ionrift-library.debug")) return false;
        return !!game.settings.get("ionrift-library", "debug");
    } catch { /* setting not registered yet */ }
    return false;
}

const Logger = game.ionrift?.library?.createLogger?.(MODULE_LABEL) ?? {
    log(...args) {
        if (!verbose()) return;
        console.log(`Ionrift ${MODULE_LABEL} |`, ...args);
    },
    info(mod, ...a) {
        if (!verbose()) return;
        console.log(`Ionrift ${mod} |`, ...a);
    },
    warn(mod, ...a) { console.warn(`Ionrift ${mod} |`, ...a); },
    error(mod, ...a) { console.error(`Ionrift ${mod} |`, ...a); }
};

export { Logger, MODULE_LABEL };
