/**
 * DnD 5e spell-to-scroll conversion and folder labels for Scroll Forge.
 */

import { ItemMaskingHelper } from "../../services/identify/ItemMaskingHelper.js";

const FORGED_FLAG = "ionrift-quartermaster";

const SCROLL_IMG_BY_SCHOOL = {
    abj: "icons/sundries/scrolls/scroll-bound-blue-white.webp",
    con: "icons/sundries/scrolls/scroll-bound-sealed-orange.webp",
    div: "icons/sundries/scrolls/scroll-symbol-eye-brown.webp",
    enc: "icons/sundries/scrolls/scroll-bound-gold.webp",
    evo: "icons/sundries/scrolls/scroll-runed-brown-white.webp",
    ill: "icons/sundries/scrolls/scroll-runed-brown-grey.webp",
    nec: "icons/sundries/scrolls/scroll-bound-skull-brown.webp",
    trs: "icons/sundries/scrolls/scroll-bound-green.webp"
};

const PACK_PRIORITY = ["dnd5e.spells24", "dnd5e.spells"];
const DEFAULT_PACK_IDS = ["dnd5e.spells24", "dnd5e.spells"];

export const DnD5eScrollForge = {
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
        const lvl = spell.system?.level;
        return typeof lvl === "number" && lvl >= 1;
    },

    getSpellLevel(spell) {
        const lvl = spell.system?.level;
        return typeof lvl === "number" && lvl >= 1 ? lvl : null;
    },

    getSpellFolderGroupKey(spell) {
        return spell.system?.school ?? "unknown";
    },

    getSpellFolderGroupLabel(groupKey) {
        const def = CONFIG.DND5E?.spellSchools?.[groupKey];
        if (def?.label) return game.i18n.localize(def.label);
        if (groupKey === "unknown") return "Unknown";
        return String(groupKey);
    },

    getSpellLevelFolderLabel(level) {
        const locKey = CONFIG.DND5E?.spellLevels?.[level];
        if (locKey) return game.i18n.localize(locKey);
        return `Level ${level}`;
    },

  /**
   * @param {Item} spell
   * @param {typeof Item} ItemClass
   */
    async spellToScrollData(spell, ItemClass) {
        const schoolKey = this.getSpellFolderGroupKey(spell);
        const scrollMeta = {
            spellName: spell.name,
            spellLevel: spell.system?.level ?? 1
        };

        if (typeof ItemClass?.createScrollFromSpell === "function") {
            try {
                const scrollConfig = { dialog: false, explanation: "full" };
                const created = await ItemClass.createScrollFromSpell(spell, {}, scrollConfig);
                const plain = created?.toObject
                    ? created.toObject()
                    : foundry.utils.duplicate(created);
                plain.flags = foundry.utils.mergeObject(plain.flags ?? {}, {
                    [FORGED_FLAG]: {
                        scrollMeta,
                        forgedFrom: spell.uuid,
                        school: schoolKey
                    }
                });
                plain.img = this.scrollImgForGroup(schoolKey);
                return plain;
            } catch {
                /* manual fallback below */
            }
        }

        return this._manualScrollFromSpell(spell, scrollMeta, schoolKey);
    },

    scrollImgForGroup(groupKey) {
        if (SCROLL_IMG_BY_SCHOOL[groupKey]) return SCROLL_IMG_BY_SCHOOL[groupKey];
        const keys = Object.keys(CONFIG.DND5E?.spellSchools ?? {});
        const idx = keys.indexOf(groupKey);
        if (idx >= 0) {
            const pool = Object.values(SCROLL_IMG_BY_SCHOOL);
            return pool[idx % pool.length];
        }
        return ItemMaskingHelper._genericIconFor("scroll");
    },

    scrollRarity(level) {
        if (level <= 1) return "common";
        if (level <= 3) return "uncommon";
        if (level <= 5) return "rare";
        if (level <= 8) return "veryRare";
        return "legendary";
    },

    scrollPrice(level) {
        const table = [0, 25, 75, 150, 300, 500, 1000, 2000, 5000, 10000, 25000];
        return table[level] ?? 25;
    },

    scrollChallengeValues(level) {
        const cfg = CONFIG.DND5E?.spellScrollValues;
        if (cfg) {
            for (let lv = level; lv >= 0; lv--) {
                if (cfg[lv]) return { dc: cfg[lv].dc, bonus: cfg[lv].bonus };
            }
        }
        const table = [
            { dc: 13, bonus: 5 },
            { dc: 13, bonus: 5 },
            { dc: 13, bonus: 5 },
            { dc: 15, bonus: 7 },
            { dc: 15, bonus: 7 },
            { dc: 17, bonus: 9 },
            { dc: 17, bonus: 9 },
            { dc: 18, bonus: 10 },
            { dc: 18, bonus: 10 },
            { dc: 19, bonus: 11 }
        ];
        return table[Math.min(level, 9)] ?? table[1];
    },

    _manualScrollFromSpell(spell, scrollMeta, schoolKey) {
        const level = scrollMeta.spellLevel;
        const rarity = this.scrollRarity(level);
        const priceVal = this.scrollPrice(level);
        const desc = spell.system?.description?.value ?? "";
        const sk = schoolKey ?? spell.system?.school ?? "unknown";

        const { dc, bonus } = this.scrollChallengeValues(level);
        const activityId = foundry.utils.randomID();
        const activities = {
            [activityId]: {
                _id: activityId,
                type: "cast",
                consumption: {
                    targets: [{ type: "itemUses", value: "1" }]
                },
                spell: {
                    challenge: { attack: bonus, save: dc, override: true },
                    level,
                    uuid: spell.uuid
                }
            }
        };

        return {
            name: `Spell Scroll (${spell.name})`,
            type: "consumable",
            img: this.scrollImgForGroup(sk),
            system: {
                description: { value: desc },
                rarity,
                weight: { value: 0.1, units: "lb" },
                price: { value: priceVal, denomination: "gp" },
                type: { value: "scroll" },
                uses: { max: 1, spent: 0, recovery: "", autoDestroy: true },
                quantity: 1,
                activities
            },
            flags: {
                [FORGED_FLAG]: {
                    scrollMeta,
                    forgedFrom: spell.uuid,
                    school: sk
                }
            }
        };
    }
};
