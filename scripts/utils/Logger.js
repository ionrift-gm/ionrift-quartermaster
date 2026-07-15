import { MODULE_LABEL } from "../data/moduleId.js";

const Logger = game.ionrift?.library?.createLogger?.(MODULE_LABEL) ?? {
    log() {},
    info(mod, ...a) { console.log(`Ionrift ${mod} |`, ...a); },
    warn(mod, ...a) { console.warn(`Ionrift ${mod} |`, ...a); },
    error(mod, ...a) { console.error(`Ionrift ${mod} |`, ...a); }
};

export { Logger, MODULE_LABEL };
