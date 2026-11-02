/** Canonicalize UUID route values to the form returned by PostgreSQL. */
export function canonicalBookRouteId(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value;
}
