# Ionrift Quartermaster Russian i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Foundry `en`/`ru` i18n and Babele pack translations for `ionrift-quartermaster` so GM-facing UI and compendium text switch with client language.

**Architecture:** Follow the suite design (`docs/superpowers/specs/2026-08-07-russian-localization-design.md` pointer → Library canonical spec). UI via `lang/en.json` + `lang/ru.json` with keys `IONRIFT.QUARTERMASTER.*`. Prefer `game.ionrift.library.localize` / `format` when Library is active; fall back to `game.i18n`. Compendiums via `babele/ru/` registered on `babele.init`. Do not rewrite EN pack sources.

**Tech Stack:** Foundry VTT v12–14, ES modules, Handlebars `{{localize}}`, Babele + lib-wrapper (recommended), Vitest (already in `package.json`).

**Spec:** Suite design in Library repo; Phase order adjusted — Respite deferred; Quartermaster next after Library.

**Dependency:** Requires localized `ionrift-library` (Phase 1) for shared helper + terrain labels. Junction/test install: `D:\VTT\Data\modules`.

## Global Constraints

- Key pattern: `IONRIFT.QUARTERMASTER.<AREA>.<NAME>`
- Ship both `lang/en.json` and `lang/ru.json`
- Voice: formal «вы»; prefer `ru-ru` / official D&D5e & PF2e RU terms
- Settings `name` / `hint` / menu `label`: pass **raw i18n keys** (Foundry auto-localizes)
- Runtime/dialog strings: `localize` / `format` at call time
- Stable ids (`dungeon`, setting keys, pack names) stay English
- Pack sources stay English; Babele overlays RU at runtime
- Do not translate README / wiki / CHANGELOG this pass
- `module.json` title/description stay English

---

## File map

| File | Responsibility |
|---|---|
| `module.json` | `languages` + recommend `babele` / `lib-wrapper` |
| `lang/en.json` / `lang/ru.json` | UI strings |
| `scripts/utils/I18n.js` | Thin wrapper: library helper if present, else `game.i18n` |
| `scripts/module.js` | Wire Babele register hook; ensure languages load |
| `scripts/services/settings/SettingsRegistrar.js` | Setting/menu strings → keys |
| `scripts/services/settings/SettingsPanelLayout.js` | Panel chrome strings → keys |
| `templates/**/*.hbs` | `{{localize}}` for hardcoded chrome |
| `scripts/apps/**/*.js` | Titles, notifications, dialogs → keys |
| `data/terrains/**` | Display labels → `labelKey` where shown in UI |
| `babele/ru/ionrift-quartermaster.quartermaster-guide-gm.json` | Journal pack translation |
| `babele/ru/ionrift-quartermaster.quartermaster-containers.json` | Item pack translation (if pack present / buildable) |
| `babele/ru/_packs-folders.json` | Folder labels if needed |
| `scripts/tests/i18n/*.test.js` | Helper + sample key parity / terrain resolution |

**Note:** This clone has `packs/quartermaster-guide-gm` on disk; `quartermaster-containers` is listed in `module.json` / `SHIPPING.json` but may need `npm run build:packs` or source under `packs/src`. Babele for containers is Task 6 — skip gracefully if pack binaries are unavailable, document in report.

---

### Task 1: Scaffold languages + I18n helper + Vitest

**Files:**
- Create: `lang/en.json`, `lang/ru.json`
- Create: `scripts/utils/I18n.js`
- Create: `scripts/tests/vitest.config.js` (if missing), `scripts/tests/setup/foundryI18nMock.js`, `scripts/tests/setup/install.js`, `scripts/tests/i18n/I18n.test.js`
- Modify: `module.json` (`languages`, extend `relationships.recommends` with `babele` + `lib-wrapper`)
- Modify: `scripts/module.js` (no Babele yet — just ensure nothing blocks; optional export of helper)

**Interfaces:**
- Produces:
  ```js
  export function localize(key) { /* library.localize || game.i18n.localize || key */ }
  export function format(key, data = {}) { /* same fallback chain */ }
  ```

- [ ] **Step 1: Write failing I18n test** (same pattern as Library Task 1 — mock `game.i18n`, assert localize/format)

- [ ] **Step 2: Run `npm test` — expect FAIL** (missing helper/config)

- [ ] **Step 3: Implement helper + empty/starter lang files + module.json languages**

`scripts/utils/I18n.js`:

```js
export function localize(key) {
  const lib = globalThis.game?.ionrift?.library;
  if (lib?.localize) return lib.localize(key);
  if (globalThis.game?.i18n?.localize) return game.i18n.localize(key);
  return key;
}

export function format(key, data = {}) {
  const lib = globalThis.game?.ionrift?.library;
  if (lib?.format) return lib.format(key, data);
  if (globalThis.game?.i18n?.format) return game.i18n.format(key, data);
  return key;
}
```

`module.json` languages:

```json
"languages": [
  { "lang": "en", "name": "English", "path": "lang/en.json" },
  { "lang": "ru", "name": "Russian", "path": "lang/ru.json" }
]
```

Add to `relationships.recommends` (alongside item-piles):

```json
{ "id": "babele", "type": "module", "reason": "Runtime translation of Quartermaster compendium packs." },
{ "id": "lib-wrapper", "type": "module", "reason": "Required by Babele." }
```

Starter keys (remove TEST keys after Task 1 tests use mock-only):

```json
{
  "IONRIFT.QUARTERMASTER.TEST.Hello": "Hello"
}
```

RU: `"Здравствуйте"`.

- [ ] **Step 4: `npm test` — PASS**

- [ ] **Step 5: Commit**

```bash
git add module.json lang scripts/utils/I18n.js scripts/tests
git commit -m "feat(i18n): add Foundry languages and Quartermaster localize helper"
```

---

### Task 2: Localize SettingsRegistrar + settings panel chrome

**Files:**
- Modify: `scripts/services/settings/SettingsRegistrar.js`
- Modify: `scripts/services/settings/SettingsPanelLayout.js` (and `AdvisoryStripUtils.js` if it has user-visible strings)
- Modify: `lang/en.json`, `lang/ru.json`

**Interfaces:**
- Consumes: Foundry auto-localization of setting keys
- Produces: all `name`/`hint`/`label` on `register` / `registerMenu` with non-empty UI text become `IONRIFT.QUARTERMASTER.SETTINGS.*`

- [ ] **Step 1: Inventory** — extract every user-visible `name`/`hint`/`label` from SettingsRegistrar + panel layout into a key list

- [ ] **Step 2: Add EN+RU keys** (Name/Hint/Label suffix convention)

- [ ] **Step 3: Replace literals with keys** (raw strings, no `localize()` at register time). Leave empty hints as `""`. Leave `config: false` settings without `name` untouched.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(i18n): localize Quartermaster settings and panel chrome"
```

---

### Task 3: Localize cache generator + signature ledger (primary GM surfaces)

**Files:**
- `templates/cache-generator.hbs`, `templates/signature-ledger.hbs`, related partials (`slot-cell.hbs`, `cache-qty-stepper.hbs`, `cache-chat-card.hbs`)
- Corresponding apps under `scripts/apps/` (cache generator, ledger)
- `lang/en.json`, `lang/ru.json`

- [ ] **Step 1: Replace hardcoded chrome** with `{{localize}}` / JS `localize`/`format`

- [ ] **Step 2: Fill RU strings** (formal «вы»)

- [ ] **Step 3: Smoke note** — Foundry check if junction available; else document skip

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(i18n): localize cache generator and signature ledger"
```

---

### Task 4: Localize remaining apps & templates

**Files (audit all remaining):**
- Templates: `quartermaster.hbs`, forge/cursed/loot/sound/party-shelf templates, etc.
- Apps: `scripts/apps/**/*.js` (forge, curse, workshop, sound, config)
- Notifications / DialogV2 titles / buttons
- `lang/en.json`, `lang/ru.json`

**Skip:** Logger/console-only; vendor; pure mechanical JSON not shown as labels.

- [ ] **Step 1: Extract and key all remaining user-visible strings**

- [ ] **Step 2: EN/RU parity** — every new en key has ru

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(i18n): localize remaining Quartermaster apps and templates"
```

---

### Task 5: Runtime data labels (terrains / cache tables display)

**Files:**
- `data/terrains/**/terrain-qm.json`, `data/terrains/manifest.json`
- Any consumer that displays terrain/cache table labels (loot registries, generator UI)
- Prefer `labelKey: "IONRIFT.QUARTERMASTER.TERRAIN.Forest"` (or reuse `IONRIFT.LIBRARY.TERRAIN.*` for the five shared base terrains via Library keys)

**Rule:** Shared base terrains (forest/swamp/desert/urban/dungeon) should use **Library** keys when the UI can call Library localize — avoid duplicate RU. QM-only terrains/themes get `IONRIFT.QUARTERMASTER.*` keys.

- [ ] **Step 1: Identify which labels are Library-shared vs QM-specific**

- [ ] **Step 2: Wire labelKey + localize at render**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(i18n): localize Quartermaster terrain and cache display labels"
```

---

### Task 6: Babele pack translations

**Files:**
- Create: `babele/ru/` directory
- Create translation JSON for available packs
- Modify: `scripts/module.js` — register on `Hooks.once("babele.init", ...)`

**Registration pattern (from `ru-ru`):**

```js
Hooks.once("babele.init", (babele) => {
  babele.register({
    module: "ionrift-quartermaster",
    lang: "ru",
    dir: "babele/ru"
  });
});
```

**Pack files naming:** `ionrift-quartermaster.<packName>.json`  
Example: `ionrift-quartermaster.quartermaster-guide-gm.json`

**How to author:**
1. Prefer Babele’s export UI in Foundry (with Babele active) for accurate entry keys
2. Or hand-translate Journal/Item `name` + `description` / pages from pack contents
3. Include `_packs-folders.json` if folder labels need RU

- [ ] **Step 1: Export or extract EN entries** for `quartermaster-guide-gm`

- [ ] **Step 2: Write RU translations** (formal tone; keep HTML in descriptions intact)

- [ ] **Step 3: If `quartermaster-containers` pack is present, add its Babele file; else note skip in report

- [ ] **Step 4: Wire `babele.init` register**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(i18n): add Babele Russian translations for Quartermaster packs"
```

---

### Task 7: Verification gate

- [ ] **Step 1: `npm test` — PASS**

- [ ] **Step 2: EN/RU key parity** (PowerShell `Compare-Object` on JSON keys — expect no diff)

- [ ] **Step 3: Optional junction** `D:\VTT\Data\modules\ionrift-quartermaster` → worktree

- [ ] **Step 4: Foundry checklist** (or mark pending honestly):
  - Language RU: settings, cache generator, ledger, forge UIs
  - Babele on: guide pack names/pages in RU
  - Babele off: packs EN, UI still RU
  - Language EN: UI matches former English

- [ ] **Step 5: Update design pointer / checklist note** in this repo’s specs pointer if useful

- [ ] **Step 6: Commit**

```bash
git commit -m "docs: mark Quartermaster i18n verification status"
```

---

## Self-review (plan vs suite design)

| Design requirement | Task |
|---|---|
| en/ru + module.json languages | Task 1 |
| Shared localize pattern | Task 1 (Library fallback) |
| Settings / UI chrome | Tasks 2–4 |
| Runtime data labelKey | Task 5 |
| Babele packs | Task 6 |
| EN↔RU switch / fallbacks | Tasks 1, 7 |
| Formal «вы» | Tasks 2–6 RU copy |
| Test via D:\VTT\Data\modules | Task 7 |

No TBD placeholders. Respite intentionally deferred.
