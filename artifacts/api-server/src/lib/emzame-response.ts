// Emzame may return a scalar ID beneath result.file or data, not only an
// object with an id field. Keep loan and goods document parsing identical.
export function emzameProviderId(body: unknown, names: string[]): string | undefined {
  const idKeys = new Set([...names, "_id", "staticFileId"]);
  const containers = new Set(["data", "result", "file", "files", "item", "items", "payload", "contract"]);
  const visited = new Set<object>();
  const walk = (value: unknown, depth: number, scalarAllowed: boolean): string | undefined => {
    if (depth > 5 || value == null) return undefined;
    if (typeof value === "string" || typeof value === "number") {
      return scalarAllowed && String(value).trim() ? String(value) : undefined;
    }
    if (typeof value !== "object" || visited.has(value)) return undefined;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1, true);
        if (found) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of idKeys) {
      const candidate = record[key];
      if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) return String(candidate);
    }
    for (const key of containers) {
      if (!(key in record)) continue;
      const found = walk(record[key], depth + 1, true);
      if (found) return found;
    }
    return undefined;
  };
  return walk(body, 0, false);
}