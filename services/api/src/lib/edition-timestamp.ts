// PostgreSQL timestamptz stores microseconds. Do not round the expected
// revision to JavaScript milliseconds before choosing a strictly newer value.
export function nextEditionTimestamp(previous: string, nowMs: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/i.exec(previous);
  if (!match || !Number.isSafeInteger(nowMs)) throw new Error("Invalid edition timestamp.");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[8];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || hour > 23 || minute > 59 || second > 59
      || (zone !== 'Z' && zone !== 'z' && (Number(zone.slice(1, 3)) > 15 || Number(zone.slice(4, 6)) > 59))) throw new Error("Invalid edition timestamp.");
  const ms = Date.parse(previous);
  if (!Number.isFinite(ms)) throw new Error("Invalid edition timestamp.");
  const before = BigInt(ms) * 1000n + BigInt((match[7] ?? '').padEnd(6, '0').slice(3));
  const clock = BigInt(nowMs) * 1000n;
  const next = before >= clock ? before + 1n : clock;
  // BigInt division truncates toward zero; normalize negative instants down.
  let wholeMs = next / 1000n, tail = next % 1000n;
  if (tail < 0n) { wholeMs--; tail += 1000n; }
  const date = new Date(Number(wholeMs));
  if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new Error("Edition timestamp cannot be advanced.");
  return `${date.toISOString().slice(0, -1)}${tail.toString().padStart(3, '0')}Z`;
}
