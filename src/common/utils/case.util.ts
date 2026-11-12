/**
 * Recursively converts object keys from snake_case to camelCase for API
 * responses. Entities/columns are snake_case internally; the wire format is
 * camelCase. Arrays are mapped; Date values and primitives pass through
 * untouched (Date is serialized to ISO by JSON.stringify).
 */
export function toCamelCaseDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toCamelCaseDeep(item));
  }
  if (value instanceof Date) {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[snakeToCamel(key)] = toCamelCaseDeep(val);
    }
    return out;
  }
  return value;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
