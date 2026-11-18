// Time parsing strictly in UTC. Date.parse("2026-10-22T23:25:00") without a zone treats the time as LOCAL —
// on a server in another zone all deadlines would shift. Here a string without a zone is taken as UTC.
export function utcMs(s?: string | null): number {
  if (!s) return NaN;
  const t = s.trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(t)) return Date.parse(t);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t)) return Date.parse(`${t.replace(' ', 'T').replace(/\s*UTC$/i, '')}Z`);
  return NaN; // unknown format — do not guess
}
