type ContactCustomer = { id: number; name: string; first_name?: string; last_name?: string };
export const normalizeContact = (s: string) => s.normalize("NFKC")
  .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776))
  .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632))
  .replace(/[يى]/g, "ی").replace(/ك/g, "ک")
  .replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/^(?:آقای|اقای|خانم)\s+/, "")
  .replace(/[\s\u200c\u200d\u200e\u200f]+/g, "").toLowerCase();

// Only complete names and complete numeric tokens are evidence. Never fuzzy-link
// a partial name or a substring of a phone number to a private customer record.
export function createSocialContactMatcher<T extends ContactCustomer>(people: T[]) {
  const byId = new Map(people.map(p => [p.id, p]));
  const byName = new Map<string, Map<number, T>>();
  for (const person of people) for (const alias of [person.name, `${person.first_name || ""} ${person.last_name || ""}`]) {
    for (const key of new Set([normalizeContact(alias || ""), normalizeContact(alias || "").replace(/[\p{P}\p{S}]/gu, "")])) {
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, new Map());
      byName.get(key)!.set(person.id, person);
    }
  }
  return (title: string) => {
  const normalized = normalizeContact(title);
  const ids = new Set((normalized.match(/[0-9]+/g) || []).map(Number));
  const name = normalized.replace(/[0-9]+/g, "")
    .replace(/crm|شناسه(?:مشتری)?|کدمشتری|مشتری/gi, "")
    .replace(/[\p{P}\p{S}]/gu, "");
  const names = [...new Map([...(byName.get(normalized)?.entries() || []), ...(byName.get(name)?.entries() || [])]).values()];
  const identified = [...ids].map(id => byId.get(id)).filter((p): p is T => p !== undefined);
  const both = names.filter(p => ids.has(p.id));
  if (both.length === 1 && identified.length === 1) return { target: both[0], candidates: both };
  if (ids.size === 0 && names.length === 1) return { target: names[0], candidates: names };
  if (!name && identified.length === 1 && ids.size === 1) return { target: identified[0], candidates: identified };
  // Conflicting names/IDs or unknown numeric suffixes need a human choice.
  const candidates = [...new Map([...names, ...identified].map(p => [p.id, p])).values()];
  return { target: null, candidates };
  };
}

export function matchSocialContact<T extends ContactCustomer>(title: string, people: T[]) {
  return createSocialContactMatcher(people)(title);
}
