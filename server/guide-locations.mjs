// The source agent's nearby planner resolves the first catalog text match.
// Use verified full landmark names so "한라산" cannot anchor on "한라산도".
// Coordinates, radius expansion and food-preference handling stay with its tools.
const aliases = {
  한라산: { name: '한라산국립공원', category: '관광지' },
  협재해변: { name: '협재해수욕장', category: '해변' },
  함덕해변: { name: '함덕해수욕장', category: '해변' },
};
const normalized = (value) => String(value ?? '').normalize('NFC').replace(/\s+/gu, '').toLowerCase();
const nearbyAlias = /(^|[\s"'“‘(])(한라산|협재해변|함덕해변)(?=(?:의)?\s*(?:근처|주변|인근))/gu;

export function normalizeGuideLocation(message, catalog) {
  if (typeof message !== 'string' || typeof catalog?.search !== 'function') return message;
  const confirmed = new Map();
  const rewritten = message.replace(nearbyAlias, (match, prefix, alias) => {
    if (!confirmed.has(alias)) {
      const target = aliases[alias];
      let name = null;
      try {
        const result = catalog.search({ q: target.name, category: target.category, limit: 20 });
        if (Array.isArray(result?.items) && result.items.some((place) =>
          place?.category === target.category && normalized(place.name) === normalized(target.name))) {
          name = target.name;
        }
      } catch { /* Keep the original question when the catalog is unavailable. */ }
      confirmed.set(alias, name);
    }
    return confirmed.get(alias) ? `${prefix}${confirmed.get(alias)}` : match;
  });
  // Preserve the original question rather than truncating its conditions.
  return rewritten.length <= 2000 ? rewritten : message;
}
