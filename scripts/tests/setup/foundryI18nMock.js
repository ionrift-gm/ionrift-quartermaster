/** @type {Record<string, string>} */
export const translations = {};

export function installFoundryI18nMock() {
    globalThis.game = {
        i18n: {
            localize(key) {
                return Object.prototype.hasOwnProperty.call(translations, key)
                    ? translations[key]
                    : key;
            },
            format(key, data = {}) {
                let str = this.localize(key);
                for (const [k, v] of Object.entries(data)) {
                    str = str.replaceAll(`{${k}}`, String(v));
                }
                return str;
            }
        }
    };
}

export function resetTranslations(next = {}) {
    for (const k of Object.keys(translations)) delete translations[k];
    Object.assign(translations, next);
}
