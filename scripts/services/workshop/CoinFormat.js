/**
 * Normalise and format D&D 5e coin values for cache UI.
 * Internal loot math uses gp; labels pick cp, sp, or gp when cleaner.
 */

/** @param {number} gp */
export function roundCoinGp(gp) {
    return Math.round((Number(gp) || 0) * 100) / 100;
}

/**
 * @param {number} gp Value in gold pieces
 * @returns {string}
 */
export function formatCoinPrice(gp) {
    const value = roundCoinGp(gp);
    if (value <= 0) return "0 gp";

    const cpTotal = Math.round(value * 100);

    if (cpTotal < 10) {
        return `${cpTotal} cp`;
    }

    if (cpTotal < 100) {
        if (cpTotal % 10 === 0) {
            return `${cpTotal / 10} sp`;
        }
        return `${cpTotal} cp`;
    }

    if (Number.isInteger(value)) {
        return `${value} gp`;
    }

    const trimmed = value.toFixed(2).replace(/\.?0+$/, "");
    return `${trimmed} gp`;
}

/**
 * @param {object} item
 * @returns {object}
 */
export function withCoinPriceLabel(item) {
    const price = roundCoinGp(item.price ?? 0);
    return {
        ...item,
        price,
        priceLabel: formatCoinPrice(price)
    };
}
