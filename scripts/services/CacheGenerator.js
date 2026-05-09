/**
 * CacheGenerator
 * Generates level-tuned, terrain-themed loot caches for placement on enemies,
 * in treasure rooms, or directly onto scenes.
 */

import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";
import { SignatureLedger } from "./SignatureLedger.js";
import { ScrollForge } from "./ScrollForge.js";
import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";

export class CacheGenerator {

    /** @type {Object|null} Loaded cache table data */
    static _tables = null;

    // ── Public API ────────────────────────────────────────────────

    /**
     * Generates a loot cache using the slot pool draw model.
     * @param {Object} options
     * @param {number} [options.tier=1] - Party tier (1-4)
     * @param {string} [options.theme="dungeon"] - Terrain theme (where the cache is)
     * @param {string} [options.ownerTheme="unspecified"] - Owner theme (whose cache it is)
     * @param {boolean} [options.silent=false] - If true, returns data without posting to chat
     * @returns {Object} { gold, items: [{ name, type, img, price, rarity, quantity }] }
     */
    static async generate(options = {}) {
        const defaultTier = game.settings?.get("ionrift-quartermaster", "defaultCacheTier") ?? 1;
        const defaultTheme = game.settings?.get("ionrift-quartermaster", "defaultCacheTheme") ?? "dungeon";

        const tier = Math.clamped(options.tier ?? defaultTier, 1, 4);
        const theme = options.theme ?? defaultTheme;
        const ownerTheme = options.ownerTheme ?? "unspecified";

        // Economy multiplier (GM configurable, default 1.0)
        const economy = game.settings?.get("ionrift-quartermaster", "lootEconomy") ?? 1.0;
        const magicMult = game.settings?.get("ionrift-quartermaster", "magicFrequency") ?? 1.0;

        const tables = await this._loadTables();
        if (tables.tiers) {
            for (const [key, td] of Object.entries(tables.tiers)) td._tier = parseInt(key);
        }
        const tierData = tables.tiers[String(tier)];
        const ownerDef = tables.ownerThemes?.[ownerTheme] ?? tables.ownerThemes?.unspecified;

        if (!tierData) {
            Logger.error(MODULE_LABEL, `Unknown tier: ${tier}`);
            return { gold: 0, items: [], container: null };
        }
        if (!ownerDef) {
            Logger.error(MODULE_LABEL, `Unknown owner theme: ${ownerTheme}`);
            return { gold: 0, items: [], container: null };
        }

        // Effective budget for this cache.
        // budgetMax caps the tier default from above (user set a ceiling).
        // budgetMin raises it from below (user wants a richer cache than the tier default).
        let effectiveBudget = (tierData.budgetCap ?? 150) * (ownerDef.budgetMultiplier ?? 1.0) * economy;
        if (options.budgetMax !== null && options.budgetMax !== undefined) effectiveBudget = Math.min(effectiveBudget, options.budgetMax);
        if (options.budgetMin !== null && options.budgetMin !== undefined) effectiveBudget = Math.max(effectiveBudget, Math.min(options.budgetMin, options.budgetMax ?? Infinity));
        const budgetFloor = options.budgetMin ?? 0;
        let spentBudget = 0;



        // Capitalise theme for display purposes when owner is unspecified
        const themeDisplay = theme.charAt(0).toUpperCase() + theme.slice(1);
        const cacheLabel = ownerTheme === "unspecified"
            ? `${themeDisplay} Cache`
            : ownerDef.label;

        const result = {
            gold: 0, items: [], container: null,
            meta: { 
                tier, theme, ownerTheme, tierLabel: tierData.label, 
                cacheLabel, economy,
                mintBatch: foundry.utils.randomID(8)
            }
        };

        // Tier-specific GP floor for filler slots
        const goldFillerFloor = [0, 5, 15, 40, 100][tier] ?? 5;

        // Pick a discovery flavor phrase for this terrain
        const phrases = tables.flavorPhrases?.[theme];
        if (phrases?.length) {
            result.meta.flavor = phrases[Math.floor(Math.random() * phrases.length)];
        }

        // ── Gold: always roll, scaled by owner theme ────────────────
        const rawGold = await this._rollGold(tierData.goldDice);
        result.gold = Math.max(0, Math.round(rawGold * (ownerDef.budgetMultiplier ?? 1.0)));
        spentBudget += result.gold;

        // ── Signature: always check the Progression Registry ──────────
        const partyActors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        const sugg = await SignatureLedger.getSuggestedRecipient(partyActors);
        if (sugg && !sugg.isSuppressed && sugg.actorId) {
            result.signatureOpportunity = sugg;
        }

        // ── Slot Pool Draw: build item slot list from owner theme ─────
        // Tier scaling factor: higher tiers produce larger, richer caches
        // T1: 1.0x, T2: 1.5x, T3: 2.0x, T4: 2.5x
        const tierScale = [0, 1.0, 1.5, 2.0, 2.5][tier] ?? 1.0;

        const slotRange = ownerDef.totalSlots ?? { min: 5, max: 8 };
        const scaledMin = Math.round(slotRange.min * tierScale);
        const scaledMax = Math.round(slotRange.max * tierScale);
        const totalSlotCount = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin;
        const pool = ownerDef.slotPool ?? {};

        // Expand guaranteed entries into a flat list of slot types.
        // Entries can be plain strings ("scroll") or range objects ({ type, min, max }).
        // Range min/max are scaled by tier.
        const guaranteed = [];
        for (const entry of (ownerDef.guaranteed ?? [])) {
            if (typeof entry === "string") {
                guaranteed.push(entry);
            } else if (entry?.type) {
                const min = Math.round((entry.min ?? 1) * tierScale);
                const max = Math.round((entry.max ?? min) * tierScale);
                const count = Math.floor(Math.random() * (max - min + 1)) + min;
                for (let j = 0; j < count; j++) guaranteed.push(entry.type);
            }
        }

        // Build the slot draw list: guaranteed first, then random from pool
        const drawnSlots = [...guaranteed];
        const remainingCount = Math.max(0, totalSlotCount - drawnSlots.length);
        for (let i = 0; i < remainingCount; i++) {
            drawnSlots.push(this._weightedPoolDraw(pool));
        }

        // Container-first ordering: pick the container before items so we
        // know the weight budget. Items that don't fit are converted to gold.
        const container = await this._pickContainer(ownerTheme, theme);
        const weightBudget = container?.capacityLbs || 999;
        let currentWeight = 0;

        // ── Fill slots ────────────────────────────────────────────────
        const guaranteedCount = guaranteed.length;
        let slotsProcessed = 0;
        // When the GM sets an explicit cap, guaranteed slots are tracked against
        // spentBudget just like filler slots. Without an override, guaranteed
        // items are uncapped (original behaviour).
        const hardCap = options.budgetMax !== null && options.budgetMax !== undefined;
        for (const slotType of drawnSlots) {
            const isGuaranteed = slotsProcessed < guaranteedCount;

            // Budget gate: filler always; guaranteed only when GM has set a hard cap
            if (spentBudget >= effectiveBudget && (!isGuaranteed || hardCap)) break;

            // Budget shaping:
            // • hardCap active: ALL slots (guaranteed + filler) share remaining budget
            //   proportionally so no single item can consume the whole budget
            // • no hardCap + guaranteed: Infinity (original uncapped behaviour)
            // • no hardCap + filler: fair share of remaining budget
            const totalSlotsLeft    = Math.max(1, drawnSlots.length - slotsProcessed);
            const fillerSlotsLeft   = Math.max(1, drawnSlots.length - Math.max(slotsProcessed, guaranteedCount));
            const remainingBudget   = effectiveBudget - spentBudget;
            const priceCeiling = hardCap
                ? Math.max(remainingBudget / totalSlotsLeft, goldFillerFloor)
                : isGuaranteed
                    ? Infinity
                    : Math.max(remainingBudget / fillerSlotsLeft, goldFillerFloor);

            let item = null;
            let pickAttempts = 0;
            
            // Repick logic: reject items that are too heavy or on the GM ban list
            while (pickAttempts < 5) {
                item = await this._pickItem(slotType, theme, tierData, tables, priceCeiling);
                if (!item) break;
                if ((Number(item.weight) || 0) > 45) {
                    item = null;
                    pickAttempts++;
                } else if (await this._isBanned(item.name)) {
                    item = null;
                    pickAttempts++;
                } else {
                    break;
                }
            }

            slotsProcessed++;

            if (item) {
                // Apply bulk quantity heuristic: cheap items stack to fill a sensible value band
                const qty = (item.quantity !== null && item.quantity !== undefined && item.quantity > 1)
                    ? item.quantity
                    : this._resolveQuantity(item);
                const totalItemPrice = Math.round((item.price ?? 0) * qty * 100) / 100;
                const totalItemWeight = (Number(item.weight) || 0) * qty;

                // Weight budget check: reject if item won't fit in container
                if (container && (currentWeight + totalItemWeight) > weightBudget && result.items.length > 0) {
                    const filler = Math.floor(totalItemPrice * 0.5);
                    result.gold += filler;
                    // Track against budget when GM set a cap or slot is filler
                    if (!isGuaranteed || hardCap) spentBudget += filler;
                } else {
                    currentWeight += totalItemWeight;
                    if (!isGuaranteed || hardCap) spentBudget += totalItemPrice;
                    result.items.push({ ...item, quantity: qty, price: totalItemPrice });
                }
            } else {
                // Nothing useful in this slot -- gold filler
                const filler = Math.floor(goldFillerFloor * (0.5 + Math.random()));
                result.gold += filler;
                if (!isGuaranteed || hardCap) spentBudget += filler;
            }
        }


        // Attach container metadata (container was picked before the item loop)
        if (container) {
            const fillPercent = container.capacityLbs > 0
                ? Math.min(100, Math.round((currentWeight / container.capacityLbs) * 100))
                : 0;

            result.container = {
                ...container,
                contentWeightLbs: currentWeight,
                fillPercent,
                isOverweight: currentWeight > container.capacityLbs
            };

            // Resolve {container} token in flavor phrase now that we know the actual container
            if (result.meta.flavor?.includes("{container}")) {
                const name = container.name.toLowerCase();
                const article = /^[aeiou]/i.test(name) ? "an" : "a";
                result.meta.flavor = result.meta.flavor.replaceAll("{container}", `${article} ${name}`);
            }
        }

        // Curse injection point — reserved for ionrift-cursewright.
        // Cursewright listens on this hook and runs its own applyCacheCurses().
        // Call signature: (result, options) — result.meta.mintBatch is the batch identity key.
        Hooks.callAll("ionrift-quartermaster.cacheGenerated", result, options);

        // Budget floor: if a minimum was dialled in and we fell short, bridge with gold
        if (budgetFloor > 0 && spentBudget < budgetFloor) {
            const topUp = Math.round(budgetFloor - spentBudget);
            result.gold += topUp;
        }

        if (result.gold > 0 && game.settings.get("ionrift-quartermaster", "distributeCoins") !== false) {
            result.coinage = this._distributeCoinage(result.gold);
        }

        if (!options.silent) {
            await this._postChatCard(result);
        }

        return result;
    }



    /**
     * Returns the list of available owner themes.
     * @returns {Object[]} [{ id, label, desc }]
     */
    static async getOwnerThemes() {
        const tables = await this._loadTables();
        return Object.entries(tables.ownerThemes ?? {}).map(([id, data]) => ({
            id, label: data.label, desc: data.desc
        }));
    }

    /**
     * Returns the list of valid theme keys.
     * @returns {string[]}
     */
    static async getThemes() {
        const tables = await this._loadTables();
        return Object.keys(tables.flavorPhrases ?? {});
    }

    // ── Slot Pool Draw ────────────────────────────────────────────

    /**
     * Draws a single slot type from a weighted pool.
     * Pool is an object like { "scroll": 4, "consumable": 3, "mundane": 1.5 }.
     * Higher weight = more likely to be drawn.
     * @param {Object} pool - Weighted slot pool
     * @returns {string} The drawn slot type
     */
    static _weightedPoolDraw(pool) {
        const entries = Object.entries(pool);
        if (entries.length === 0) return "mundane"; // safety fallback
        const total = entries.reduce((sum, [, w]) => sum + w, 0);
        let roll = Math.random() * total;
        for (const [type, weight] of entries) {
            roll -= weight;
            if (roll <= 0) return type;
        }
        return entries[entries.length - 1][0];
    }

    // ── Data Loading ──────────────────────────────────────────────

    static async _loadTables() {
        if (this._tables) return this._tables;

        try {
            const response = await fetch(`modules/${MODULE_ID}/data/cache-tables.json`);
            this._tables = await response.json();
        } catch (e) {
            Logger.error(MODULE_LABEL, "Failed to load cache-tables.json:", e);
            this._tables = { tiers: {}, ownerThemes: {}, flavorPhrases: {} };
        }

        return this._tables;
    }

    // ── Item Picking ──────────────────────────────────────────────

    /**
     * Picks a random item from the appropriate pool for this slot type.
     * Queries enabled compendiums via ItemPoolResolver.
     */
    static async _pickItem(slotType, theme, tierData, tables, priceCeiling = Infinity) {
        let item;
        switch (slotType) {
            case "scroll":      item = await this._pickScroll(tierData, priceCeiling); break;
            case "consumable":  item = await this._pickConsumable(theme, tierData, tables, priceCeiling); break;
            case "mundane":     item = await this._pickMundane(theme, tierData, tables, priceCeiling); break;
            case "mastercraft": item = await this._pickMastercraft(theme, tierData, priceCeiling); break;
            case "gemstone":    item = await this._pickGemstone(theme, tierData, priceCeiling); break;
            case "trinket":     item = await this._pickTrinket(theme, tierData, priceCeiling); break;
            case "treasure":    item = await this._pickTreasure(theme, tierData, priceCeiling); break;
            default:            return null;
        }

        // Enrich with magical identification masking metadata
        if (item) {
            const mask = ItemMaskingHelper.detectMagical(item);
            if (mask.isMagical) {
                item._isMagical    = true;
                item._baseItemName = mask.baseItemName;
                item._mundaneDesc  = mask.mundaneDesc;
                if (mask.obscuredImg) {
                    item._maskSourceImg = item.img;
                    item._obscuredImg = mask.obscuredImg;
                    item.img          = mask.obscuredImg;
                }
            }
        }
        return item;
    }

    /**
     * Pick a cultural/mastercraft weapon or armor from the quartermaster-core compendium.
     * Filters to items priced within the tier's typical range.
     */
    static async _pickMastercraft(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        const priceMax = Math.min([0, 100, 400, 1500, 5000][tier], priceCeiling);
        const priceMin = [0, 5,   30,  200,  800 ][tier];

        const terrainMaterials = {
            jungle:     ['Obsidian', 'Hardened Bamboo', 'Jaguar Hide', 'Mastercraft'],
            coastal:    ['Coral Steel', 'Mastercraft'],
            forest:     ['Ironwood', 'Elven Steel', 'Hardened Bamboo', 'Mastercraft'],
            swamp:      ['Ironwood', 'Mastercraft'],
            dungeon:    ['Dwarven Steel', 'Mastercraft'],
            desert:     ['Mastercraft', 'Obsidian'],
            urban:      ['Mastercraft', 'Elven Steel'],
            mountain:   ['Dwarven Steel', 'Mastercraft'],
            arctic:     ['Dwarven Steel', 'Mastercraft'],
        };
        const preferredMaterials = terrainMaterials[theme] ?? ['Mastercraft'];

        // Primary: query enabled compendiums via ItemPoolResolver (includes SRD dnd5e.items)
        try {
            const item = await ItemPoolResolver.pickRandom({
                slotType: "mastercraft",
                tier: tierData._tier ?? 1,
                theme,
                priceCeiling
            });
            if (item) return { ...item, quantity: 1 };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for mastercraft:", e.message);
        }

        // Fallback: quartermaster-core cultural and mastercraft items
        try {
            const pack = game.packs.get('ionrift-quartermaster.quartermaster-core');
            if (pack) {
                const index = await pack.getIndex({ fields: ['name', 'img', 'system.price', 'system.weight', 'system.rarity', 'system.type', 'flags'] });
                const eligible = index.filter(e => {
                    const price = e.system?.price?.value ?? 0;
                    const meta = e.flags?.['ionrift-quartermaster']?.coreMeta;
                    if (!meta) return false;
                    const cat = meta.category;
                    if (!['Cultural Weapons', 'Cultural Armor', 'Mastercraft'].includes(cat)) return false;
                    return price >= priceMin && price <= priceMax;
                });

                if (eligible.length === 0) return null;

                const themed = eligible.filter(e => {
                    const mat = e.flags?.['ionrift-quartermaster']?.coreMeta?.material ?? '';
                    return preferredMaterials.includes(mat);
                });
                const pool = themed.length > 0 ? themed : eligible;
                const pick = pool[Math.floor(Math.random() * pool.length)];
                return {
                    name: pick.name,
                    type: pick.type ?? 'weapon',
                    img: pick.img,
                    price: pick.system?.price?.value ?? 30,
                    weight: pick.system?.weight?.value ?? 3,
                    rarity: pick.system?.rarity ?? 'common',
                    _baseItem: pick.system?.type?.baseItem ?? '',
                    quantity: 1,
                    _compendiumId: pick._id,
                    sourceCompendium: 'ionrift-quartermaster.quartermaster-core'
                };
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "quartermaster-core mastercraft query failed:", e.message);
        }
        return null;
    }

    /**
     * Pick a gemstone from the quartermaster-gemstones compendium.
     * Tier gates which quality tier of gemstone is eligible.
     */
    static async _pickGemstone(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Tier 1 = chips+common, Tier 2 = +semi-precious, Tier 3 = +precious, Tier 4 = +flawless
        const eligibleTiers = [
            [],
            ['Chips & Fragments', 'Polished Common'],
            ['Chips & Fragments', 'Polished Common', 'Semi-Precious'],
            ['Polished Common', 'Semi-Precious', 'Precious'],
            ['Semi-Precious', 'Precious', 'Flawless']
        ][tier] ?? ['Polished Common'];

        // Weight toward lower tiers so chips/fragments appear more often at low tier
        const tierWeights = { 'Chips & Fragments': 4, 'Polished Common': 3, 'Semi-Precious': 2, 'Precious': 1, 'Flawless': 0.5 };

        try {
            const pack = game.packs.get('ionrift-quartermaster.quartermaster-gemstones');
            if (pack) {
                const index = await pack.getIndex({ fields: ['name', 'img', 'system.price', 'flags'] });
                const eligible = index.filter(e => {
                    const gemTier = e.flags?.['ionrift-quartermaster']?.gemMeta?.tier;
                    if (!eligibleTiers.includes(gemTier)) return false;
                    const price = e.system?.price?.value ?? 0;
                    return price <= priceCeiling;
                });
                if (eligible.length === 0) return null;

                // Weighted random selection
                const weighted = [];
                for (const e of eligible) {
                    const gemTier = e.flags?.['ionrift-quartermaster']?.gemMeta?.tier ?? 'Polished Common';
                    const w = tierWeights[gemTier] ?? 1;
                    for (let i = 0; i < w; i++) weighted.push(e);
                }

                // Apply terrain bias on top of tier weighting
                const pick = this._terrainWeightedPick(weighted, theme);
                return {
                    name: pick.name,
                    type: 'loot',
                    img: pick.img,
                    price: pick.system?.price?.value ?? 10,
                    weight: pick.system?.weight?.value ?? 0.1,
                    rarity: pick.system?.rarity ?? 'common',
                    quantity: 1,
                    _compendiumId: pick._id,
                    sourceCompendium: 'ionrift-quartermaster.quartermaster-gemstones'
                };
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "quartermaster-gemstones query failed:", e.message);
        }
        return null;
    }

    /**
     * Pick an art object or trade good from the quartermaster-treasure compendium.
     * Tier 1 = trade goods + cheap art, Tier 2+ = broader price range.
     */
    static async _pickTreasure(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Price gates by tier (art objects go up to ~250 gp, trade goods up to 100 gp)
        const priceMax = Math.min([0, 80, 200, 500, 5000][tier] ?? 80, priceCeiling);
        const priceMin = [0, 10,  40, 100,  250][tier] ?? 10;

        try {
            const pack = game.packs.get('ionrift-quartermaster.quartermaster-treasure');
            if (pack) {
                const index = await pack.getIndex({ fields: ['name', 'img', 'system.price', 'system.weight', 'flags'] });
                const eligible = index.filter(e => {
                    const price = e.system?.price?.value ?? 0;
                    return price >= priceMin && price <= priceMax;
                });
                if (eligible.length === 0) return null;
                const pick = this._terrainWeightedPick([...eligible], theme);
                return {
                    name: pick.name,
                    type: 'loot',
                    img: pick.img,
                    price: pick.system?.price?.value ?? 20,
                    weight: pick.system?.weight?.value ?? 0.5,
                    rarity: 'common',
                    quantity: 1,
                    _compendiumId: pick._id,
                    sourceCompendium: 'ionrift-quartermaster.quartermaster-treasure'
                };
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "quartermaster-treasure query failed:", e.message);
        }
        return null;
    }


    static async _pickTrinket(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Tier-gating: trinkets have a price ceiling per tier
        const trinketCeiling = Math.min([0, 25, 75, 200, 500][tier] ?? 25, priceCeiling);

        try {
            const pack = game.packs.get('ionrift-quartermaster.quartermaster-core');
            if (pack) {
                const index = await pack.getIndex({ fields: ['name', 'img', 'system.price', 'system.weight', 'flags'] });
                const eligible = index.filter(e => {
                    const cat = e.flags?.['ionrift-quartermaster']?.coreMeta?.category;
                    if (cat !== 'Trinkets') return false;
                    const price = e.system?.price?.value ?? 0;
                    return price <= trinketCeiling;
                });
                if (eligible.length === 0) return null;
                const pick = this._terrainWeightedPick([...eligible], theme);
                return {
                    name: pick.name,
                    type: pick.type ?? 'loot',
                    img: pick.img,
                    price: pick.system?.price?.value ?? 5,
                    weight: pick.system?.weight?.value ?? 0.1,
                    rarity: pick.system?.rarity ?? 'common',
                    quantity: 1,
                    _compendiumId: pick._id,
                    sourceCompendium: 'ionrift-quartermaster.quartermaster-core'
                };
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "quartermaster-core trinket query failed:", e.message);
        }
        return null;
    }

    /**
     * Pick a scroll from the forged world scroll compendium at the appropriate level.
     * Falls back to the stub list if the compendium is unavailable.
     */
    static async _pickScroll(tierData, priceCeiling = Infinity) {
        let maxLevel = tierData.scrollLevelMax ?? 2;
        
        // Scroll jitter: small chance to exceed the tier cap by 1-N levels
        const jitter = game.settings?.get("ionrift-quartermaster", "scrollJitter") ?? 0;
        if (jitter > 0 && Math.random() < 0.15) {
            const extra = Math.ceil(Math.random() * jitter);
            maxLevel = Math.min(maxLevel + extra, 9);
        }
        
        const level = this._weightedScrollLevel(maxLevel);

        try {
            const forgedId = `world.${ScrollForge.WORLD_PACK_NAME}`;
            const pack = game.packs.get(forgedId);
            if (pack) {
                const index = await pack.getIndex({ fields: ["name", "img", "system.price", "flags"] });
                const scrollPrices = { 1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240 };

                // Exact level match first, fall back to <= level if empty
                let eligible = index.filter(e => {
                    const spellLevel = e.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellLevel;
                    if (!spellLevel || spellLevel !== level) return false;
                    return (scrollPrices[spellLevel] ?? 60) <= priceCeiling;
                });
                if (eligible.length === 0) {
                    eligible = index.filter(e => {
                        const spellLevel = e.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellLevel;
                        if (!spellLevel || spellLevel > level) return false;
                        return (scrollPrices[spellLevel] ?? 60) <= priceCeiling;
                    });
                }

                if (eligible.length > 0) {
                    // Party spell awareness: prefer scrolls the party doesn't already know
                    const partySpells = this._getPartyKnownSpells();
                    const novel = eligible.filter(e => {
                        const spellName = e.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellName;
                        return spellName && !partySpells.has(spellName.toLowerCase());
                    });
                    const finalPool = novel.length > 0 ? novel : eligible;

                    const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
                    const scrollMeta = pick.flags?.["ionrift-quartermaster"]?.scrollMeta ?? {};
                    return {
                        name: pick.name,
                        type: "consumable",
                        img: pick.img ?? ItemMaskingHelper._genericIconFor("scroll"),
                        price: scrollPrices[scrollMeta.spellLevel] ?? 60,
                        weight: 0.05,
                        rarity: scrollMeta.spellLevel <= 2 ? "common" : scrollMeta.spellLevel <= 4 ? "uncommon" : "rare",
                        quantity: 1,
                        spellLevel: scrollMeta.spellLevel,
                        spellName: scrollMeta.spellName,
                        _compendiumId: pick._id,
                        sourceCompendium: forgedId
                    };
                }
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Scroll compendium query failed, using stub:", e.message);
        }

        // Fallback stub
        return this._generateScrollStub(tierData);
    }

    /**
     * Weighted scroll level selection. Mid-tier scrolls are favored over
     * edge levels (1 and max) to produce a more balanced distribution.
     */
    static _weightedScrollLevel(maxLevel) {
        if (maxLevel <= 1) return 1;
        const weights = {};
        for (let i = 1; i <= maxLevel; i++) {
            weights[i] = Math.min(i, maxLevel - i + 1);
        }
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        let roll = Math.random() * total;
        for (const [lvl, w] of Object.entries(weights)) {
            roll -= w;
            if (roll <= 0) return parseInt(lvl);
        }
        return maxLevel;
    }

    /**
     * Collects all known spell names from party characters.
     * Uses SystemAdapter when ionrift-lib is available, with DnD5e fallback.
     */
    static _getPartyKnownSpells() {
        const SA = game.ionrift?.library?.system;
        const known = new Set();
        const actors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        for (const actor of actors) {
            if (SA) {
                for (const spell of SA.getKnownSpells(actor)) known.add(spell);
            } else {
                for (const item of actor.items) {
                    if (item.type === "spell") known.add(item.name.toLowerCase());
                }
            }
        }
        return known;
    }

    /**
     * Terrain-weighted random pick from a pool of compendium index entries.
     * Items with a matching `flags["ionrift-quartermaster"].terrain` array entry
     * get a 2x weight multiplier. Items without the flag are terrain-neutral
     * and always eligible at 1x weight.
     *
     * @param {Object[]} pool - Array of compendium index entries
     * @param {string} theme - Current terrain theme
     * @returns {Object} The selected item
     */
    static _terrainWeightedPick(pool, theme) {
        if (!theme || pool.length === 0) return pool[Math.floor(Math.random() * pool.length)];

        const weighted = pool.map(item => {
            const terrains = item.flags?.['ionrift-quartermaster']?.terrain ?? [];
            const multiplier = terrains.includes(theme) ? 2 : 1;
            return { item, weight: multiplier };
        });
        const total = weighted.reduce((sum, w) => sum + w.weight, 0);
        let roll = Math.random() * total;
        for (const { item, weight } of weighted) {
            roll -= weight;
            if (roll <= 0) return item;
        }
        return weighted[weighted.length - 1].item;
    }

    /**
     * Pick a consumable, biased toward actual potions and elixirs.
     * Resolves the full pool then splits it: 70% chance to draw from
     * the potion sub-pool, 30% from everything else.
     */
    static async _pickConsumable(theme, tierData, tables, priceCeiling = Infinity) {
        // Gather the full consumable pool
        let pool = [];
        try {
            pool = await ItemPoolResolver.resolve({
                slotType: "consumable",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables
            });
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for consumable:", e.message);
        }

        // If resolver returned nothing, no consumables available for this theme/tier
        // (compendiums are the sole source of truth)

        if (!pool.length) return null;

        // Price ceiling
        const affordable = pool.filter(p => (p.price ?? 0) <= priceCeiling);
        const finalPool = affordable.length > 0 ? affordable : pool;

        // Split: potions vs everything else
        const isPotionLike = (item) => {
            const n = (item.name ?? "").toLowerCase();
            return n.includes("potion") || n.includes("elixir") || n.includes("philter")
                || n.includes("oil of") || n.includes("antitoxin")
                || (item.subtype ?? "").toLowerCase() === "potion";
        };

        const potions = finalPool.filter(isPotionLike);
        const other   = finalPool.filter(i => !isPotionLike(i));

        // 70% potion bias when potions exist
        let pick;
        if (potions.length > 0 && (other.length === 0 || Math.random() < 0.7)) {
            pick = potions[Math.floor(Math.random() * potions.length)];
        } else {
            pick = finalPool[Math.floor(Math.random() * finalPool.length)];
        }

        return {
            name: pick.name,
            type: "consumable",
            subtype: pick.subtype ?? "",
            img: pick.img ?? "icons/consumables/potions/potion-bottle-corked-red.webp",
            price: pick.price ?? 0,
            weight: 0.1,
            rarity: pick.rarity ?? "common",
            quantity: 1,
            sourceCompendium: pick.sourceCompendium,
            _compendiumId: pick._compendiumId
        };
    }

    /**
     * Pick a mundane/trade goods item from enabled compendiums.
     */
    static async _pickMundane(theme, tierData, tables, priceCeiling = Infinity) {
        try {
            const item = await ItemPoolResolver.pickRandom({
                slotType: "mundane",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables
            });
            if (item) return { ...item, quantity: 1 };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for mundane:", e.message);
        }
        return null;
    }

    /**
     * Stub scroll generator. Phase 2 will use the real scroll compendium.
     * For now, generates a named scroll at an appropriate level.
     */
    static _generateScrollStub(tierData) {
        const maxLevel = tierData.scrollLevelMax;
        const level = Math.max(1, Math.floor(Math.random() * maxLevel) + 1);

        // Placeholder spell names by level (Phase 2 replaces with compendium lookup)
        const spellsByLevel = {
            1: ["Shield", "Healing Word", "Magic Missile", "Detect Magic", "Sleep", "Thunderwave", "Bless", "Guiding Bolt", "Feather Fall", "Mage Armor"],
            2: ["Misty Step", "Hold Person", "Shatter", "Spiritual Weapon", "Web", "Invisibility", "Lesser Restoration", "Mirror Image"],
            3: ["Fireball", "Counterspell", "Revivify", "Fly", "Haste", "Spirit Guardians", "Dispel Magic", "Lightning Bolt"],
            4: ["Greater Invisibility", "Banishment", "Dimension Door", "Polymorph", "Wall of Fire", "Death Ward"],
            5: ["Cone of Cold", "Hold Monster", "Raise Dead", "Wall of Force", "Telekinesis", "Greater Restoration"],
            6: ["Chain Lightning", "Disintegrate", "Heal", "Globe of Invulnerability", "Sunbeam"],
            7: ["Teleport", "Finger of Death", "Forcecage", "Resurrection", "Plane Shift"],
            8: ["Power Word Stun", "Maze", "Sunburst", "Feeblemind", "Dominate Monster"],
            9: ["Wish", "Power Word Kill", "Meteor Swarm", "True Resurrection", "Gate"]
        };

        const pool = spellsByLevel[level] ?? spellsByLevel[1];
        const spell = pool[Math.floor(Math.random() * pool.length)];

        const scrollPrices = { 1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240 };

        return {
            name: `Scroll of ${spell}`,
            type: "consumable",
            img: ItemMaskingHelper._genericIconFor("scroll"),
            price: scrollPrices[level] ?? 60,
            rarity: level <= 2 ? "common" : level <= 4 ? "uncommon" : level <= 6 ? "rare" : level <= 8 ? "veryRare" : "legendary",
            quantity: 1,
            spellLevel: level,
            spellName: spell
        };
    }

    /**
     * Check if an item is on the GM ban list and should be excluded from generation.
     *
     * @param {string} itemName
     * @returns {Promise<boolean>}
     */
    static async _isBanned(itemName) {
        if (!itemName) return false;
        try {
            const banSet = await SignatureLedger.getBanSet();
            return banSet.has(itemName.toLowerCase());
        } catch {
            return false; // Never block generation on ledger errors
        }
    }

    // ── Dice Rolling ──────────────────────────────────────────────

    static async _rollGold(formula) {
        try {
            const roll = await new Roll(formula).evaluate();
            return Math.floor(roll.total);
        } catch {
            return 5;
        }
    }

    /**
     * Price-based quantity heuristic.
     *
     * Cheap consumables and mundane goods naturally come in multiples.
     * The target value band (how much gp this slot *should* represent)
     * is chosen randomly within sensible bounds, then divided by the
     * unit price to get a quantity. This is purely mathematical --
     * no name lookups or item-type lists.
     *
     * Price brackets (per unit):
     *   < 0.05 gp  -> target 0.5-2 gp   -> e.g. 10-40 torches
     *   < 0.5  gp  -> target 0.5-3 gp   -> e.g. 1-6 rations
     *   < 2    gp  -> target 1-4 gp     -> e.g. 1-4 candles/chalk
     *   < 5    gp  -> target 2-6 gp     -> e.g. 1-2 flasks of oil
     *   >= 5   gp  -> quantity 1 always
     *
     * Signature, scroll, gem, and magic items are never multiplied.
     *
     * @param {Object} item
     * @returns {number}
     */
    static _resolveQuantity(item) {
        // Never stack these item classes
        if (item.isSignature || item.spellName) return 1;
        const rarity = (item.rarity ?? "common").toLowerCase();
        if (rarity !== "common" && rarity !== "none" && rarity !== "") return 1;
        if (item.sourceCompendium === "ionrift-quartermaster.quartermaster-gemstones") return 1;

        const unitPrice = item.price ?? 0;
        if (unitPrice <= 0) return 1;

        let targetMin, targetMax, qtyMax;
        if (unitPrice < 0.05) {
            targetMin = 0.5;  targetMax = 2;   qtyMax = 50;
        } else if (unitPrice < 0.5) {
            targetMin = 0.5;  targetMax = 3;   qtyMax = 20;
        } else if (unitPrice < 2) {
            targetMin = 1;    targetMax = 4;   qtyMax = 10;
        } else if (unitPrice < 5) {
            targetMin = 2;    targetMax = 6;   qtyMax = 4;
        } else {
            return 1;
        }

        const targetValue = targetMin + Math.random() * (targetMax - targetMin);
        const qty = Math.max(1, Math.min(qtyMax, Math.round(targetValue / unitPrice)));
        return qty;
    }

    // ── Chat Output ───────────────────────────────────────────────

    /** @type {Map<string, Object>} Pending cache results awaiting user action */
    static _pendingCaches = new Map();
    /**
     * Splits a raw GP value into a randomized mix of standard 5e coin denominations.
     */
    static _distributeCoinage(totalGp) {
        if (!totalGp || totalGp <= 0) return null;
        
        let remainingCp = Math.floor(totalGp * 100);
        const coins = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
        
        // 1. PP alloc (only sometimes when large enough)
        if (remainingCp >= 1000 && Math.random() < 0.6) {
            const maxPp = Math.floor(remainingCp / 1000);
            const ppAlloc = Math.floor(maxPp * (0.1 + Math.random() * 0.4));
            coins.pp = ppAlloc;
            remainingCp -= (ppAlloc * 1000);
        }
        
        // 2. EP alloc (rarely, small amounts)
        if (remainingCp >= 50 && Math.random() < 0.2) {
            const epAlloc = Math.floor(Math.random() * 10) + 1;
            const cost = epAlloc * 50;
            if (cost <= remainingCp * 0.2) {
                coins.ep = epAlloc;
                remainingCp -= cost;
            }
        }
        
        // 3. SP and CP (small handfuls)
        const spAlloc = Math.floor(Math.random() * 50);
        if (spAlloc * 10 <= remainingCp * 0.2) {
            coins.sp = spAlloc;
            remainingCp -= spAlloc * 10;
        }
        
        const cpAlloc = Math.floor(Math.random() * 100);
        if (cpAlloc <= remainingCp * 0.1) {
            coins.cp = cpAlloc;
            remainingCp -= cpAlloc;
        }
        
        // 4. GP takes the bulk
        const gpAlloc = Math.floor(remainingCp / 100);
        coins.gp = gpAlloc;
        remainingCp -= (gpAlloc * 100);
        
        // Dump absolute remainder into SP/CP
        if (remainingCp >= 10) {
            const extraSp = Math.floor(remainingCp / 10);
            coins.sp += extraSp;
            remainingCp -= extraSp * 10;
        }
        if (remainingCp > 0) {
            coins.cp += remainingCp;
        }
        
        for (const k of Object.keys(coins)) {
            if (coins[k] === 0) delete coins[k];
        }
        
        return Object.keys(coins).length > 0 ? coins : null;
    }

    static async _postChatCard(result) {
        const { gold, items, meta } = result;

        const cacheId = foundry.utils.randomID();
        this._pendingCaches.set(cacheId, result);

        const signatures = items.filter(i => i.isSignature);
        const scrolls    = items.filter(i => i.spellName);
        const weapons    = items.filter(i => (i.type === 'weapon' || i.type === 'equipment') && !i.isSignature);
        const gemstones  = items.filter(i => i.sourceCompendium === 'ionrift-quartermaster.quartermaster-gemstones');
        const treasures  = items.filter(i => i.sourceCompendium === 'ionrift-quartermaster.quartermaster-treasure');
        const consumables= items.filter(i => i.type === 'consumable' && !i.spellName && !i.isSignature);
        const mundane    = items.filter(i => !i.isSignature && !i.spellName
                            && i.type !== 'weapon' && i.type !== 'equipment'
                            && i.sourceCompendium !== 'ionrift-quartermaster.quartermaster-gemstones'
                            && i.sourceCompendium !== 'ionrift-quartermaster.quartermaster-treasure'
                            && (i.type === 'loot' || i.type === 'tool' || !i.type));

        let html = `<div class="ionrift-cache-card" style="font-family: var(--ionrift-font, inherit);">`;
        html += `<h3 style="margin:0 0 2px; border-bottom: 1px solid rgba(255,255,255,0.15);">`;
        html += `<i class="fas fa-treasure-chest" style="margin-right:4px;"></i> ${meta.cacheLabel}</h3>`;
        html += `<p style="margin:2px 0; opacity:0.8; font-size:0.85em;">${meta.tierLabel} | ${meta.theme.charAt(0).toUpperCase() + meta.theme.slice(1)} terrain</p>`;

        // Flavor
        if (meta.flavor) {
            html += `<p style="margin:6px 0 8px; font-style:italic; opacity:0.75; font-size:0.9em; border-left:2px solid rgba(255,255,255,0.2); padding-left:8px;">${meta.flavor}</p>`;
        }

        // Gold
        if (gold > 0) {
            html += `<div style="margin:6px 0; padding:4px 8px; background:rgba(218,165,32,0.15); border-radius:4px;">`;
            
            let coinStr = `<strong>${gold} gp</strong>`;
            if (result.coinage) {
                const parts = [];
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (result.coinage[denom]) parts.push(`<strong>${result.coinage[denom]} ${denom}</strong>`);
                }
                coinStr = parts.join(", ");
            }
            
            html += `<i class="fas fa-coins" style="color:gold;margin-right:4px;"></i> ${coinStr}</div>`;
        }

        // Signature items
        if (signatures.length) {
            html += `<div style="margin:6px 0;"><strong style="color:#daa520;">Signature Items</strong>`;
            for (const item of signatures) {
                html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">`;
                html += `<img src="${item.img}" width="24" height="24" style="border:0;border-radius:3px;" />`;
                html += `<span>${item.name}</span>`;
                html += `<span style="opacity:0.6;font-size:0.8em;margin-left:auto;">${item.rarity}</span>`;
                html += `</div>`;
            }
            html += `</div>`;
        }

        // Scrolls
        if (scrolls.length) {
            html += `<div style="margin:6px 0;"><strong style="color:#7b68ee;">Spell Scrolls</strong>`;
            for (const item of scrolls) {
                html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">`;
                html += `<img src="${item.img}" width="24" height="24" style="border:0;border-radius:3px;" />`;
                html += `<span>${item.name}</span>`;
                html += `<span style="opacity:0.6;font-size:0.8em;margin-left:auto;">Lvl ${item.spellLevel}</span>`;
                html += `</div>`;
            }
            html += `</div>`;
        }

        // Treasures (art objects + trade goods)
        if (treasures.length) {
            html += `<div style="margin:6px 0;"><strong style="color:#e8c97a;">Treasure</strong>`;
            for (const item of treasures) {
                html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">`;
                html += `<img src="${item.img}" width="24" height="24" style="border:0;border-radius:3px;" />`;
                html += `<span>${item.name}</span>`;
                html += `<span style="opacity:0.6;font-size:0.8em;margin-left:auto;">${item.price} gp</span>`;
                html += `</div>`;
            }
            html += `</div>`;
        }

        // Consumables
        if (consumables.length) {
            html += `<div style="margin:6px 0;"><strong style="color:#3cb371;">Consumables</strong>`;
            for (const item of consumables) {
                html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">`;
                html += `<img src="${item.img}" width="24" height="24" style="border:0;border-radius:3px;" />`;
                html += `<span>${item.name}</span>`;
                html += `<span style="opacity:0.6;font-size:0.8em;margin-left:auto;">${item.price} gp</span>`;
                html += `</div>`;
            }
            html += `</div>`;
        }

        // Mundane
        if (mundane.length) {
            html += `<div style="margin:6px 0;"><strong style="color:#cd853f;">Trade Goods</strong>`;
            for (const item of mundane) {
                html += `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">`;
                html += `<img src="${item.img}" width="24" height="24" style="border:0;border-radius:3px;" />`;
                html += `<span>${item.name}</span>`;
                html += `<span style="opacity:0.6;font-size:0.8em;margin-left:auto;">${item.price} gp</span>`;
                html += `</div>`;
            }
            html += `</div>`;
        }

        // Total value footer
        const totalValue = Math.round((gold + items.reduce((sum, i) => sum + (i.price ?? 0), 0)) * 100) / 100;
        html += `<div style="margin-top:8px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1);font-size:0.85em;opacity:0.7;">`;
        html += `Est. Total Value: ${totalValue} gp | ${items.length} items</div>`;

        // Create-in-world button (uses data-attribute, not inline JS)
        html += `<button type="button" class="ionrift-cache-create" data-cache-id="${cacheId}" `;
        html += `style="margin-top:6px;width:100%;cursor:pointer;">`;
        html += `<i class="fas fa-box-open"></i> Create Items in World</button>`;

        html += `</div>`;

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Ionrift Quartermaster" }),
            content: html,
            whisper: game.users.filter(u => u.isGM).map(u => u.id)
        });
    }

    /**
     * Binds click handlers on cache chat card buttons.
     * Called from a renderChatMessage hook in module.js.
     */
    static bindChatListeners(html) {
        html.find(".ionrift-cache-create").on("click", async (event) => {
            const cacheId = event.currentTarget.dataset.cacheId;
            const result = this._pendingCaches.get(cacheId);
            if (!result) {
                ui.notifications.warn("Cache data expired. Generate a new cache.");
                return;
            }
            await this.createCacheItems(result);
            // Disable button after use
            $(event.currentTarget).prop("disabled", true).text("Created");
            this._pendingCaches.delete(cacheId);
        });
    }

    /**
     * Creates all items from a cache result into the world Items directory.
     * Called from the chat card button.
     * @param {Object} cacheResult - Output from generate()
     */
    static async createCacheItems(cacheResult, options = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can create cache items.");
            return;
        }

        const items = cacheResult.items ?? [];
        const { wrapInContainer = false, containerTerrain = 'any' } = options;

        // Create a folder for this cache
        const folderName = `Cache: ${cacheResult.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        let folder = game.folders.find(f => f.name === folderName && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null });
        }

        // Build item data for all generated items
        const toCreate = items.map(item => {
            const base = {
                name: item.name,
                type: item.type ?? "loot",
                img: item.img ?? "icons/svg/item-bag.svg",
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${cacheResult.meta?.cacheLabel ?? "loot cache"}.</p>` }
                },
                flags: {
                    "ionrift-quartermaster": {
                        ...(item.flags?.["ionrift-quartermaster"] || {}),
                        mintBatch: cacheResult.meta?.mintBatch
                    }
                }
            };

            if (item._isMagical) {
                ItemMaskingHelper.applyMask(base, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return base;
        });

        // Add gold as a loot item
        if (cacheResult.gold > 0) {
            if (cacheResult.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (cacheResult.coinage[denom]) {
                        toCreate.push({
                            name: `Coins (${denom.toUpperCase()})`,
                            type: "loot",
                            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                            folder: folder.id,
                            system: { price: { value: cacheResult.coinage[denom], denomination: denom } }
                        });
                    }
                }
            } else {
                toCreate.push({
                    name: "Coin Purse",
                    type: "loot",
                    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                    folder: folder.id,
                    system: {
                        quantity: 1,
                        price: { value: cacheResult.gold, denomination: "gp" },
                        description: { value: `<p>${cacheResult.gold} gold pieces.</p>` }
                    }
                });
            }
        }

        if (wrapInContainer && toCreate.length > 0) {
            // Pick a terrain-matched container from quartermaster-containers
            const container = await this._pickContainer(containerTerrain);
            if (container) {
                // Create the container, then place all generated items inside it
                const [containerItem] = await Item.create([{
                    name: container.name,
                    type: 'container',
                    img: container.img,
                    folder: folder.id,
                    system: container.system ?? {}
                }]);
                // Place all items inside the container using dnd5e container system
                const innerItems = toCreate.map(i => ({ ...i, folder: folder.id, system: { ...i.system, container: containerItem.id } }));
                await Item.create(innerItems);
                ui.notifications.info(`Created "${container.name}" with ${innerItems.length} items in "${folderName}".`);
                return;
            }
        }

        const created = await Item.create(toCreate);
        ui.notifications.info(`Created ${created.length} items in "${folderName}".`);
    }

    /**
     * Pick a terrain and owner-theme appropriate container from quartermaster-containers.
     * Accepts ownerTheme for auto-matching and contentWeightLbs for capacity preference.
     * Returns a plain metadata object (not a Foundry document).
     */
    static async _pickContainer(ownerTheme = 'unspecified', theme = 'any', contentWeightLbs = 0) {
        try {
            const pack = game.packs.get('ionrift-quartermaster.quartermaster-containers');
            if (!pack) {
                return null;
            }
            const index = await pack.getIndex({ fields: ['name', 'img', 'system', 'flags'] });
            const pool = index.contents || Array.from(index) || [];

            if (pool.length === 0) return null;

            // Primary filter: matches ownerTheme (check both new and legacy flag fields)
            const byTheme = pool.filter(e => {
                const meta = e.flags?.['ionrift-quartermaster']?.containerMeta ?? {};
                const themes = meta.ownerThemes ?? meta.cacheTypes ?? [];
                return themes.includes(ownerTheme);
            });

            // If no theme match, fall back to all containers
            const activePool = byTheme.length > 0 ? byTheme : pool;

            // Secondary filter: prefer terrain-matched
            const byTerrain = activePool.filter(e => {
                const terrains = e.flags?.['ionrift-quartermaster']?.containerMeta?.terrains ?? ['any'];
                return terrains.includes(theme);
            });
            const terrainPool = byTerrain.length > 0 ? byTerrain : activePool;

            // Prefer containers with sufficient capacity
            const withCapacity = terrainPool.filter(e => {
                const cap = e.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0;
                return cap >= contentWeightLbs;
            });
            const finalPool = withCapacity.length > 0 ? withCapacity : terrainPool;

            if (finalPool.length === 0) return null;
            const pick = finalPool[Math.floor(Math.random() * finalPool.length)];

            const emptyWeightLbs = ItemPoolResolver._extractWeight(pick);
            const packId = `${MODULE_ID}.quartermaster-containers`;

            return {
                name: pick.name,
                img: pick.img,
                type: pick.type ?? "container",
                capacityLbs: pick.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0,
                emptyWeightLbs,
                _compendiumId: pick._id,
                sourceCompendium: packId,
                ...(pick.system
                    ? { system: foundry.utils.deepClone(pick.system) }
                    : {})
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Container pick failed:", e.message);
            return null;
        }
    }

    /**
     * Creates all items from a cache result into the world Items directory.
     * Fallback path used when Item Piles is not installed.
     * @param {Object} result - Output from generate()
     */
    static async _addToItems(result) {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can create cache items.");
            return { count: 0 };
        }

        const items = result.items ?? [];
        const folderName = `Cache: ${result.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        let folder = game.folders.find(f => f.name === folderName && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null });
        }

        const toCreate = items.map(item => {
            const data = {
                name: item.name,
                type: item.type ?? "loot",
                img: item.img ?? "icons/svg/item-bag.svg",
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    weight: { value: item.weight ?? 0, units: "lb" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${result.meta?.cacheLabel ?? "loot cache"}.</p>` }
                }
            };

            // Apply identification masking for magical items
            if (item._isMagical) {
                ItemMaskingHelper.applyMask(data, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return data;
        });

        // Add gold as loot items
        if (result.gold > 0) {
            if (result.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (result.coinage[denom]) {
                        toCreate.push({
                            name: `Coins (${denom.toUpperCase()})`,
                            type: "loot",
                            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                            folder: folder.id,
                            system: { price: { value: result.coinage[denom], denomination: denom } }
                        });
                    }
                }
            } else {
                toCreate.push({
                    name: "Coin Purse",
                    type: "loot",
                    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                    folder: folder.id,
                    system: {
                        quantity: 1,
                        price: { value: result.gold, denomination: "gp" },
                        description: { value: `<p>${result.gold} gold pieces.</p>` }
                    }
                });
            }
        }

        const created = await Item.create(toCreate);

        ui.notifications.info(`Cache added to Items directory: ${created.length} items in "${folderName}".`);
        
        return { count: created.length };
    }
}
