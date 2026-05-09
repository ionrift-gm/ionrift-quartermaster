/**
 * Triage script for riftitems_export.json
 * Categorizes items into: scrolls, generic, campaign (ToA), homebrew
 * Run with: node scripts/triage-riftitems.mjs <path-to-export.json>
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'data', 'triage-output');

// Folder names that indicate Tomb of Annihilation / campaign-specific items
const TOA_FOLDERS = new Set([
    'reed woven', 'elven steel', 'equipment',
    'chultan', 'jungle', 'dinosaur', 'yuan-ti', 'port nyanzaru',
    'tomb', 'omu', 'merchant prince'
]);

// Folder names that indicate scrolls
const SCROLL_INDICATORS = ['scroll', 'spell scroll', 'cleric spell scrolls'];

// Known homebrew indicators (flags from other modules)
const HOMEBREW_FLAGS = ['magic-items-2', 'rest-recovery'];

async function main() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error('Usage: node triage-riftitems.mjs <path-to-riftitems_export.json>');
        process.exit(1);
    }

    console.log(`Reading ${inputPath}...`);
    const raw = await readFile(inputPath, 'utf-8');
    const data = JSON.parse(raw);
    const items = data.items ?? [];
    console.log(`Found ${items.length} items.`);

    // Categories
    const scrolls = [];
    const generic = [];
    const campaign = [];
    const homebrew = [];

    // Unique folder names for inspection
    const folderNames = new Set();

    for (const item of items) {
        const folder = (item.folderName ?? '').toLowerCase().trim();
        folderNames.add(item.folderName ?? '(none)');

        // 1. Scrolls: type=consumable + scroll subtype or folder/name match
        if (isScroll(item, folder)) {
            scrolls.push(enrichScroll(item));
            continue;
        }

        // 2. Campaign-specific (ToA folders, campaign tags)
        if (isCampaignItem(item, folder)) {
            campaign.push(item);
            continue;
        }

        // 3. Homebrew (has magic-items-2 enabled, custom properties, etc.)
        if (isHomebrew(item)) {
            homebrew.push(item);
            continue;
        }

        // 4. Generic (everything else)
        generic.push(item);
    }

    console.log('\n=== TRIAGE RESULTS ===');
    console.log(`Scrolls:  ${scrolls.length}`);
    console.log(`Generic:  ${generic.length}`);
    console.log(`Campaign: ${campaign.length}`);
    console.log(`Homebrew: ${homebrew.length}`);
    console.log(`Total:    ${scrolls.length + generic.length + campaign.length + homebrew.length}`);

    console.log('\n=== FOLDER NAMES ===');
    for (const f of [...folderNames].sort()) {
        console.log(`  ${f}`);
    }

    console.log('\n=== SCROLL BREAKDOWN BY LEVEL ===');
    const byLevel = {};
    for (const s of scrolls) {
        const lvl = s._scrollMeta?.spellLevel ?? '?';
        byLevel[lvl] = (byLevel[lvl] ?? 0) + 1;
    }
    for (const [lvl, count] of Object.entries(byLevel).sort((a, b) => a[0] - b[0])) {
        console.log(`  Level ${lvl}: ${count} scrolls`);
    }

    // Write output
    await mkdir(OUTPUT_DIR, { recursive: true });

    await writeFile(join(OUTPUT_DIR, 'scrolls.json'), JSON.stringify({ count: scrolls.length, items: scrolls }, null, 2));
    await writeFile(join(OUTPUT_DIR, 'generic.json'), JSON.stringify({ count: generic.length, items: generic }, null, 2));
    await writeFile(join(OUTPUT_DIR, 'campaign.json'), JSON.stringify({ count: campaign.length, items: campaign }, null, 2));
    await writeFile(join(OUTPUT_DIR, 'homebrew.json'), JSON.stringify({ count: homebrew.length, items: homebrew }, null, 2));

    // Write a scroll summary for quick review
    const scrollSummary = scrolls.map(s => ({
        name: s.name,
        spellLevel: s._scrollMeta?.spellLevel,
        spellName: s._scrollMeta?.spellName,
        folder: s.folderName,
        rarity: s.system?.rarity
    }));
    await writeFile(join(OUTPUT_DIR, 'scroll-summary.json'), JSON.stringify(scrollSummary, null, 2));

    console.log(`\nOutput written to ${OUTPUT_DIR}`);
}

// ── Classification Functions ──────────────────────────────

function isScroll(item, folder) {
    // Check consumable type with scroll subtype
    if (item.type === 'consumable' && item.system?.type?.value === 'scroll') return true;

    // Check folder name
    if (SCROLL_INDICATORS.some(s => folder.includes(s))) return true;

    // Check item name pattern
    if (/^scroll\s*[-–]\s*\d/i.test(item.name)) return true;
    if (/^scroll of /i.test(item.name)) return true;

    return false;
}

function isCampaignItem(item, folder) {
    // Check folder against known ToA folders
    if (TOA_FOLDERS.has(folder)) return true;

    // Check for Chult/ToA keywords in description
    const desc = item.system?.description?.value ?? '';
    if (/chult|tomb of annihilation|port nyanzaru|omu|yuan-ti|dinosaur/i.test(desc)) return true;

    // Check for specific material types (Reed Woven, Elven Steel are campaign homebrew)
    if (/reed woven|elven steel/i.test(item.name)) return true;

    return false;
}

function isHomebrew(item) {
    // Items with magic-items-2 "enabled" flag are likely homebrew-enchanted
    if (item.flags?.['magic-items-2']?.enabled) return true;

    // Items with custom source (not SRD)
    const source = item.system?.source?.book ?? '';
    if (source && !source.includes('SRD') && !source.includes('PHB') && !source.includes('DMG')) return true;

    return false;
}

// ── Scroll Enrichment ─────────────────────────────────────

function enrichScroll(item) {
    const enriched = { ...item };

    // Parse spell level and name from the item name
    // Patterns: "Scroll - 1st Level - Bless", "Scroll of Shield", etc.
    let spellLevel = null;
    let spellName = null;

    // Pattern: "Scroll - Xth Level - SpellName"
    const dashMatch = item.name.match(/scroll\s*[-–]\s*(\d+)\w*\s*level\s*[-–]\s*(.+)/i);
    if (dashMatch) {
        spellLevel = parseInt(dashMatch[1]);
        spellName = dashMatch[2].trim();
    }

    // Pattern: "Scroll of SpellName"
    if (!spellName) {
        const ofMatch = item.name.match(/scroll of (.+)/i);
        if (ofMatch) {
            spellName = ofMatch[1].trim();
        }
    }

    // Try to infer level from folder name (e.g., "Level1", "Level2")
    if (!spellLevel && item.folderName) {
        const folderLvl = item.folderName.match(/level\s*(\d+)/i);
        if (folderLvl) spellLevel = parseInt(folderLvl[1]);
    }

    // Try to infer level from rarity
    if (!spellLevel && item.system?.rarity) {
        const rarityToLevel = { common: 1, uncommon: 3, rare: 5, 'very rare': 7, legendary: 9 };
        spellLevel = rarityToLevel[item.system.rarity.toLowerCase()] ?? null;
    }

    enriched._scrollMeta = {
        spellLevel,
        spellName,
        saveDC: item.system?.save?.dc ?? null,
        attackBonus: item.system?.attack?.bonus ?? null,
        schoolHint: null, // Would need spell database to fill
        classHints: inferClassFromFolder(item.folderName)
    };

    return enriched;
}

function inferClassFromFolder(folderName) {
    if (!folderName) return [];
    const lower = folderName.toLowerCase();
    const classes = [];
    if (lower.includes('wizard') || lower.includes('mage')) classes.push('wizard');
    if (lower.includes('cleric')) classes.push('cleric');
    if (lower.includes('druid')) classes.push('druid');
    if (lower.includes('bard')) classes.push('bard');
    if (lower.includes('sorcerer')) classes.push('sorcerer');
    if (lower.includes('warlock')) classes.push('warlock');
    if (lower.includes('paladin')) classes.push('paladin');
    if (lower.includes('ranger')) classes.push('ranger');
    return classes;
}

main().catch(e => { console.error(e); process.exit(1); });
