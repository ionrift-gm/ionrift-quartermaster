/**
 * Merge separate journal page JSON files into parent journals before compile.
 */
import fs from "fs";
import path from "path";

/**
 * @param {string} moduleRoot
 * @param {string} srcDir
 * @returns {{ srcDir: string, cleanup: (() => void) | null }}
 */
export function stageJournalPackSrc(moduleRoot, srcDir) {
    const entries = fs.readdirSync(srcDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({
            file: f,
            doc: JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf8")),
        }));

    const pageDocs = [];
    const parents = new Map();
    const standalone = [];

    for (const entry of entries) {
        const key = entry.doc._key ?? "";
        if (key.startsWith("!journal.pages!")) {
            pageDocs.push(entry);
        } else if (key.startsWith("!journal!")) {
            parents.set(entry.doc._id, entry);
        } else {
            standalone.push(entry);
        }
    }

    if (pageDocs.length === 0) {
        return { srcDir, cleanup: null };
    }

    for (const { doc: page } of pageDocs) {
        const match = (page._key ?? "").match(/^!journal\.pages!([^.]+)\./);
        const parentId = match?.[1];
        if (!parentId) continue;
        const parent = parents.get(parentId);
        if (!parent) continue;
        if (!Array.isArray(parent.doc.pages)) {
            parent.doc.pages = [];
        }
        parent.doc.pages.push(page);
    }

    const tmpDir = fs.mkdtempSync(path.join(moduleRoot, ".pack-stage-"));
    for (const entry of parents.values()) {
        fs.writeFileSync(
            path.join(tmpDir, entry.file),
            `${JSON.stringify(entry.doc, null, 4)}\n`,
        );
    }
    for (const entry of standalone) {
        fs.writeFileSync(
            path.join(tmpDir, entry.file),
            `${JSON.stringify(entry.doc, null, 4)}\n`,
        );
    }

    return {
        srcDir: tmpDir,
        cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
}
