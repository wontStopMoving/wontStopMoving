/** Staff lookup matching (#187). Self-contained so tests can import it directly. */
export type LookupCandidate = { uid: string; role: 'customer' | 'provider'; accountNumber: string; name: string; company: string; email: string; phones: readonly string[]; addresses: readonly string[] };
export type LookupMatch = 'account' | 'phone' | 'email' | 'name' | 'company' | 'address';
export type LookupHit = Omit<LookupCandidate, 'phones' | 'addresses'> & { phones: string[]; addresses: string[]; matched: LookupMatch };

export const digitsOnly = (s: string) => s.replace(/\D/g, '');
/** Drop a leading U.S. country code so +1 (415) 555-0100 and 4155550100 compare equal. */
const usDigits = (s: string) => { const d = digitsOnly(s); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9@. ]/g, ' ').split(/\s+/).filter(Boolean);

/** Which field matched, or null. Every word of the query must appear in that one field. */
export function matchesLookup(c: LookupCandidate, query: string): LookupMatch | null {
  const q = query.trim();
  if (q.length < 2) return null;
  // Account number: "WSM-48213", "wsm48213", or just the 5 digits (checked before phone fragments).
  const acct = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^WSM\d*$/.test(acct)) return c.accountNumber && c.accountNumber.replace(/[^A-Z0-9]/g, '').startsWith(acct) ? 'account' : null;
  if (/^\d{5}$/.test(acct) && c.accountNumber === `WSM-${acct}`) return 'account';
  // Phone: only digits and phone punctuation, at least 4 digits (the last 4 work).
  if (/^[\d\s()+.-]+$/.test(q) && digitsOnly(q).length >= 4) {
    const want = usDigits(q);
    return c.phones.some(p => usDigits(p).includes(want)) ? 'phone' : null;
  }
  const qw = words(q);
  if (!qw.length) return null;
  const has = (field: string) => { const fw = words(field).join(' '); return !!fw && qw.every(w => fw.includes(w)); };
  if (q.includes('@') && has(c.email)) return 'email';
  if (has(c.name)) return 'name';
  if (has(c.company)) return 'company';
  if (c.addresses.some(has)) return 'address';
  if (has(c.email)) return 'email';
  return null;
}
