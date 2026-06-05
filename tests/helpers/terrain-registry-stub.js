export function normalizeTerrainCategory(category) {
    const value = String(category ?? "").trim().toLowerCase();
    if (!value) return "wilderness";
    return value;
}
