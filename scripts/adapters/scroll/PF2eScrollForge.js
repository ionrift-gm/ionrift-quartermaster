/**
 * Pathfinder 2e spell-to-scroll conversion for Scroll Forge.
 * Uses the system API when present; otherwise builds a compendium-faithful scroll stub.
 */

import { ItemMaskingHelper } from "../../services/identify/ItemMaskingHelper.js";

const FORGED_FLAG = "ionrift-quartermaster";

const PACK_PRIORITY = ["pf2e.spells-srd", "pf2e.spells"];
const DEFAULT_PACK_IDS = ["pf2e.spells-srd"];

const TRADITION_LABELS = {
    arcane:  "PF2E.TraitArcane",
    divine:  "PF2E.TraitDivine",
    primal:  "PF2E.TraitPrimal",
    occult:  "PF2E.TraitOccult"
};

const SCROLL_IMG_BY_TRADITION = {
    arcane: "icons/sundries/scrolls/scroll-bound-blue-white.webp",
    divine: "icons/sundries/scrolls/scroll-bound-gold.webp",
    primal: "icons/sundries/scrolls/scroll-bound-green.webp",
    occult: "icons/sundries/scrolls/scroll-runed-brown-grey.webp"
};

/** PF2e treasure-table scroll prices by spell rank (gp). */
const SCROLL_PRICE_BY_RANK = [
    0, 4, 6, 30, 70, 125, 200, 320, 500, 800, 1200
];

export const PF2eScrollForge = {
    getRecommendedPackIds() {
        return DEFAULT_PACK_IDS;
    },

    getDefaultSpellPackIds(candidates) {
        const candidateIds = new Set(candidates.map(c => c.id));
        const defaults = DEFAULT_PACK_IDS.filter(id => candidateIds.has(id));
        return defaults.length ? defaults : [];
    },

    sortSpellPacks(spellPacks) {
        spellPacks.sort((a, b) => {
            const ai = PACK_PRIORITY.indexOf(a.collection);
            const bi = PACK_PRIORITY.indexOf(b.collection);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        return spellPacks;
    },

    isLeveledSpell(spell) {
        return this.getSpellLevel(spell) !== null;
    },

    getSpellLevel(spell) {
        const raw = spell.system?.level?.value ?? spell.system?.rank;
        if (typeof raw !== "number" || raw < 1) return null;
        return raw;
    },

    getSpellFolderGroupKey(spell) {
        const traditions = spell.system?.traits?.traditions;
        if (Array.isArray(traditions) && traditions.length) return traditions[0];
        const school = spell.system?.school?.value ?? spell.system?.school;
        if (school) return String(school);
        return "unknown";
    },

    getSpellFolderGroupLabel(groupKey) {
        const locKey = TRADITION_LABELS[groupKey] ?? CONFIG.PF2E?.magicTraditions?.[groupKey]?.label;
        if (locKey) return game.i18n.localize(locKey);
        if (groupKey === "unknown") return "Unknown";
        return String(groupKey);
    },

    getSpellLevelFolderLabel(level) {
        const locKey = CONFIG.PF2E?.spellLevels?.[level];
        if (locKey) return game.i18n.localize(locKey);
        return `Rank ${level}`;
    },

    scrollPrice(rank) {
        return SCROLL_PRICE_BY_RANK[Math.min(rank, SCROLL_PRICE_BY_RANK.length - 1)] ?? 4;
    },

    scrollRarity(rank) {
        if (rank <= 2) return "common";
        if (rank <= 4) return "uncommon";
        if (rank <= 8) return "rare";
        return "unique";
    },

    scrollImgForGroup(groupKey) {
        if (SCROLL_IMG_BY_TRADITION[groupKey]) return SCROLL_IMG_BY_TRADITION[groupKey];
        const keys = Object.keys(SCROLL_IMG_BY_TRADITION);
        const idx = keys.indexOf(groupKey);
        if (idx >= 0) {
            const pool = Object.values(SCROLL_IMG_BY_TRADITION);
            return pool[idx % pool.length];
        }
        return ItemMaskingHelper._genericIconFor("scroll");
    },

  /**
   * @param {Item} spell
   * @param {typeof Item} ItemClass
   */
    async spellToScrollData(spell, ItemClass) {
        const traditionKey = this.getSpellFolderGroupKey(spell);
        const level = this.getSpellLevel(spell) ?? 1;
        const scrollMeta = {
            spellName: spell.name,
            spellLevel: level
        };

        const fromApi = await this._trySystemScroll(spell, ItemClass, level);
        if (fromApi) {
            fromApi.flags = foundry.utils.mergeObject(fromApi.flags ?? {}, {
                [FORGED_FLAG]: {
                    scrollMeta,
                    forgedFrom: spell.uuid,
                    tradition: traditionKey
                }
            });
            if (!fromApi.img) fromApi.img = this.scrollImgForGroup(traditionKey);
            return fromApi;
        }

        return this._manualScrollFromSpell(spell, scrollMeta, traditionKey);
    },

    async _trySystemScroll(spell, ItemClass, level) {
        const opts = { type: "scroll", heightenedLevel: level, mystified: false };
        const candidates = [
            () => ItemClass?.createConsumableFromSpell?.(spell, opts),
            () => game.pf2e?.Item?.createConsumableFromSpell?.(spell, opts),
            () => game.pf2e?.documents?.ItemPF2e?.createConsumableFromSpell?.(spell, opts),
            () => spell?.createConsumableFromSpell?.(opts)
        ];

        for (const call of candidates) {
            try {
                const created = await call();
                if (!created) continue;
                return created?.toObject
                    ? created.toObject()
                    : foundry.utils.duplicate(created);
            } catch {
                /* try next API surface */
            }
        }
        return null;
    },

    _manualScrollFromSpell(spell, scrollMeta, traditionKey) {
        const level = scrollMeta.spellLevel;
        const spellSource = spell.toObject ? spell.toObject() : foundry.utils.duplicate(spell);
        delete spellSource._id;

        const traditions = spell.system?.traits?.traditions ?? [];
        const traitValues = ["magical", "scroll", ...traditions];

        return {
            name: `Scroll of ${spell.name}`,
            type: "consumable",
            img: this.scrollImgForGroup(traditionKey),
            system: {
                category: "scroll",
                level: { value: level },
                traits: {
                    value: traitValues,
                    rarity: this.scrollRarity(level)
                },
                description: { value: spell.system?.description?.value ?? "" },
                price: { value: { gp: this.scrollPrice(level) } },
                bulk: { value: 0.1 },
                quantity: 1,
                uses: { value: 1, max: 1, per: null },
                spell: { value: spellSource }
            },
            flags: {
                [FORGED_FLAG]: {
                    scrollMeta,
                    forgedFrom: spell.uuid,
                    tradition: traditionKey
                }
            }
        };
    }
};
