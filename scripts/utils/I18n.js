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
