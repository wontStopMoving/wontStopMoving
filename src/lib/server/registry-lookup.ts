import { nameKey, REGISTRY_AREAS } from '@/lib/registry';
import { politeFetch } from './soda-token';

export const COMPANY_CENSUS_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';

export type NotListed = { dot: string; name: string; dba: string; city: string; state: string; reason: string };

/**
 * A name search found nothing in the registry: ask the DOT census directly, so
 * the page can say why a known company isn't listed (inactive, no household
 * goods on its filing, ...) instead of showing an empty list (#108).
 */
export async function notListedFor(q: string, fetchCensus = politeFetch): Promise<NotListed[]> {
  // Only letters, digits and spaces are kept, so nothing can break out of the quoted pattern.
  const words = q.toUpperCase().replace(/['’]/g, '').replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  const key = words.join('');
  if (key.length < 3) return [];
  // Each word in order; "cant"/"wont"/"dont" also match the apostrophe spelling ("CAN'T").
  const pattern = (ws: string[]) => `%${ws.join('%')}%`;
  const likes = [...new Set([pattern(words), pattern(words.map(w => w.replace(/NT$/, 'N%T')))])];
  const qs = new URLSearchParams({
    $select: 'dot_number,legal_name,dba_name,phy_city,phy_state,status_code,crgo_household',
    $where: /^\d{3,9}$/.test(key) ? `dot_number='${key}'` :
      likes.map(l => `upper(legal_name) like '${l}' OR upper(dba_name) like '${l}'`).join(' OR '),
    $order: 'status_code, dot_number', $limit: '50',
  });
  const res = await fetchCensus(`${COMPANY_CENSUS_URL}?${qs}`, 20_000).catch(() => null);
  const rows = res?.ok ? ((await res.json()) as Record<string, string>[]) : [];
  return rows
    .filter(r => r.dot_number === key || nameKey(r.legal_name || '').includes(key) || nameKey(r.dba_name || '').includes(key))
    .slice(0, 10)
    .map(r => ({
      dot: String(Number(r.dot_number || 0)), name: String(r.legal_name || ''), dba: String(r.dba_name || ''), city: String(r.phy_city || ''), state: String(r.phy_state || ''),
      reason: r.status_code !== 'A' ? 'The federal USDOT registration is inactive. State moving permits are listed separately.'
        : r.crgo_household !== 'X' ? 'Its DOT filing doesn’t list household goods, so it isn’t counted as a mover.'
        : !REGISTRY_AREAS.includes(String(r.phy_state || '')) ? 'Registered outside the areas we import.'
        : 'Active household-goods carrier in the federal census. Its record is missing from the current registry import.',
    }));
}
