import { adminDb } from './firebase-admin';
import { loadCarriers, loadNational, loadPartners, loadStates, scanRegistry } from './registry-store';
import { zipLookup } from './geo';
import { collectRegistryMap, registryMap, type MapPoint } from '@/lib/registry-map';
import { CATEGORY_COLOR, CATEGORY_KEYS, filterCarriers, primaryCategory, sortCarriers, tupleToMover, type CategoryKey, type LocatedCarrier } from '@/lib/carriers';
import { REGION_PRESETS, areaCounties } from '@/lib/regions';
import { explainRank, filterMovers, ourRank, sizeScore, sortMovers, REGISTRY_AREAS, yearsInBusiness, type Mover, type MoverFilters, type OurFleet, type RankingMover, type SortKey, type UsProfile } from '@/lib/registry';

/**
 * Answers registry searches. Searches inside a region, a few states or a map
 * area use the imported state snapshots. The lightweight national index
 * serves the likely-mover browse view; names and unrestricted views include all filings.
 */
export type StateSummary = { state: string; count: number; likely: number; carriers?: number | null; partners?: number | null; categories?: Record<string, number> | null; units: number; drivers: number; top: (Partial<Mover> & { size: number })[]; updatedAt: string | null; bbox: { south: number; west: number; north: number; east: number } | null; center: [number, number] | null };

let summaryCache: { at: number; rows: StateSummary[] } | null = null;
export async function stateSummaries(force = false): Promise<StateSummary[]> {
  if (!force && summaryCache && Date.now() - summaryCache.at < 5 * 60_000) return summaryCache.rows;
  const snap = await adminDb().collection('registryStates').get();
  const rows = snap.docs.map(d => { const x = d.data(); return { ...x, state: d.id, updatedAt: x.updatedAt?.toDate?.().toISOString() || null } as StateSummary; });
  summaryCache = { at: Date.now(), rows };
  return rows;
}

const overlaps = (a: NonNullable<StateSummary['bbox']>, b: NonNullable<MoverFilters['bbox']>) => !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);

/**
 * '' = moving companies (the default), 'partners' = the partner shortlist
 * (each state's best freight, car-carrier, container... candidates), or one
 * service category of other for-hire carriers.
 */
export type CarrierType = '' | 'partners' | Exclude<CategoryKey, 'household'>;
export const CARRIER_TYPES = ['partners', ...CATEGORY_KEYS.filter(k => k !== 'household')] as Exclude<CarrierType, ''>[];

export type RegistryQuery = MoverFilters & { type?: CarrierType; sort?: SortKey; page?: number; pageSize?: number; rankBy?: 'size' | 'units' | 'drivers' };

type SearchOptions = { points?: boolean; all?: boolean; allLimit?: number; zoom?: number };

function moverPoints(rows: RankingMover[]): MapPoint[] {
  return rows.flatMap(m => m.lat !== null && m.lng !== null ?
    [[m.dot, m.lat, m.lng, m.dba || m.name, m.units, m.state]] : []);
}

async function scanLikelyRegistry<T>(states: string[], filter: (rows: Mover[]) => T[]) {
  const indexed = await loadNational(REGISTRY_AREAS);
  const indexedStates = new Set(indexed.states);
  const fallback = await scanRegistry(states.filter(state => !indexedStates.has(state)), filter);
  return { rows: [...filter(indexed.rows), ...fallback.rows], states: [...indexed.states, ...fallback.states] };
}

/** Map panning needs only the coordinates and labels, without ranking or retaining the full records. */
export async function searchMoverMap(query: RegistryQuery, zoom: number) {
  const map = collectRegistryMap(query.bbox, zoom);
  const append = (rows: Mover[]) => {
    map.add(moverPoints(filterMovers(rows, query)));
    return [];
  };
  const { states } = await (query.q || query.likelyOnly === false
    ? scanRegistry(REGISTRY_AREAS, append)
    : scanLikelyRegistry(REGISTRY_AREAS, append));
  return { map: map.result(), nationalComplete: REGISTRY_AREAS.every(state => states.includes(state)) };
}

// Search the complete snapshots, but retain only ranking fields until the
// requested page or CSV has been selected. Full national records exceed the
// App Hosting instance's memory limit.
const rankingFields = ({ dot, name, dba, city, state, units, drivers, miles, added, lat, lng, site, hhgAuth }: Mover): RankingMover =>
  ({ dot, name, dba, city, state, units, drivers, miles, added, lat, lng, site, hhgAuth });

async function selectedRecords(entries: RankingMover[], fullRows?: Mover[]) {
  const wanted = new Map<string, Set<string>>();
  for (const { state, dot } of entries) {
    const ids = wanted.get(state) ?? new Set<string>();
    ids.add(dot);
    wanted.set(state, ids);
  }
  const selected = (rows: Mover[]) => rows.filter(m => wanted.get(m.state)?.has(m.dot));
  const rows = fullRows ? selected(fullRows) : (await scanRegistry([...wanted.keys()], selected)).rows;
  return new Map(rows.map(row => [`${row.state}/${row.dot}`, row]));
}

export async function searchRegistry(q: RegistryQuery, us: UsProfile | null, opts: SearchOptions = {}) {
  const summaries = await stateSummaries();
  const region = q.region ? REGION_PRESETS[q.region] : undefined;
  const states = region?.states ?? q.states?.filter(state => REGISTRY_AREAS.includes(state)) ?? [];
  if (q.type) {
    // The larger non-moving carrier indexes still require a bounded area.
    const carrierStates = states.length || !q.bbox ? states : summaries.filter(s => s.bbox && overlaps(s.bbox, q.bbox!)).map(s => s.state);
    return searchCarriers(q, q.type, carrierStates, !carrierStates.length || carrierStates.length > 6, summaries, opts);
  }

  const national = !states.length || states.length > 6;
  const requestedStates = states.length ? states : REGISTRY_AREAS;
  const filters = { ...q, states, area: region };
  let rows: RankingMover[];
  let fullRows: Mover[] | undefined;
  let knownStates = requestedStates;
  let elsewhere: Mover[] = [];
  const name = q.q?.trim();
  const lookupOutside = name && (states.length || q.city || q.zip || q.bbox || q.near);
  if (name || q.likelyOnly === false) {
    const broader = { ...filters, states: undefined, area: undefined, city: undefined, zip: undefined, bbox: undefined, near: undefined };
    const full = await scanRegistry(lookupOutside ? REGISTRY_AREAS : requestedStates, list => {
      const candidates = filterMovers(list, lookupOutside ? broader : filters);
      if (!lookupOutside) return candidates.map(rankingFields);
      const local = filterMovers(candidates, filters);
      const localIds = new Set(local.map(m => m.dot));
      elsewhere = sortMovers([...elsewhere, ...candidates.filter(m => !localIds.has(m.dot))], 'size').slice(0, 10);
      return local.map(rankingFields);
    });
    rows = full.rows;
    knownStates = full.states;
  } else if (national || q.bbox) {
    // Use the actual coordinates to filter a viewport. Summary bounding boxes
    // discard outlying ZIPs and aren't a source of map coverage.
    const indexed = await scanLikelyRegistry(requestedStates, list => filterMovers(list, filters));
    rows = fullRows = indexed.rows;
    knownStates = indexed.states;
  } else {
    rows = fullRows = filterMovers(await loadStates(states), filters);
  }
  const complete = requestedStates.every(state => knownStates.includes(state));
  const near = q.near ? { lat: q.near.lat, lng: q.near.lng } : undefined;
  const sorted = sortMovers(rows, q.sort || 'size', near);
  const pageSize = Math.min(Math.max(q.pageSize || 50, 1), opts.all ? 10000 : 200);
  const page = Math.max(q.page || 1, 1);
  const rank = us ? ourRank(rows, us, q.rankBy || 'size') : null;
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const allRows = opts.all ? sorted.slice(0, opts.allLimit ?? sorted.length) : undefined;
  const records = await selectedRecords(allRows ? [...pageRows, ...allRows] : pageRows, fullRows);
  const details = (entries: RankingMover[]) => entries.flatMap(({ state, dot }) => {
    const record = records.get(`${state}/${dot}`);
    return record ? [record] : [];
  });
  return {
    mode: national ? 'national' as const : 'detailed' as const,
    nationalComplete: national ? complete : undefined,
    states: national ? summaries.map(s => s.state) : states,
    total: sorted.length,
    rows: details(pageRows),
    all: allRows ? details(allRows) : undefined,
    rank: rank ? { rank: rank.rank, of: rank.of, nextUp: rank.nextUp.map(m => ({ dot: m.dot, name: m.dba || m.name, city: m.city, state: m.state, units: m.units, drivers: m.drivers, years: yearsInBusiness(m), gap: rank.gapTo(m) })) } : null,
    explain: us ? explainRank(rows, us) : null,
    map: opts.points ? registryMap(moverPoints(sorted), q.bbox, opts.zoom ?? 0) : undefined,
    totals: { units: rows.reduce((n, m) => n + m.units, 0), drivers: rows.reduce((n, m) => n + m.drivers, 0) },
    updatedAt: summaries.filter(s => !national ? states.includes(s.state) : true).map(s => s.updatedAt).filter(Boolean).sort().pop() || null,
    elsewhere,
  };
}

/** Our fleet for ranking, from Competitors → Our numbers. */
export async function ourFleet(): Promise<UsProfile> {
  // Until Wont Stop Moving has its own USDOT record, authority comes from the owner's setting (competitorSettings/us.hasAuthority).
  const settings = (await adminDb().doc('competitorSettings/us').get()).data() || {};
  const m = settings.metrics || {};
  return { units: Number(m.trucks || 0), drivers: Number(m.drivers || 0), miles: 0, years: Number(m.yearsInBusiness || 0), hasAuthority: settings.hasAuthority === true, hasWebsite: true };
}

/** Find one company by DOT number in its state's file. */
export async function findMover(dot: string, state: string): Promise<Mover | null> {
  const rows = await loadStates([state]);
  return rows.find(m => m.dot === dot) || null;
}

export { sizeScore };

/**
 * Other for-hire carriers (freight, car carriers, …): a region, a few states
 * or a map area at a time; state files are big, so no nationwide lists.
 */
async function searchCarriers(q: RegistryQuery, type: Exclude<CarrierType, ''>, states: string[], national: boolean, summaries: StateSummary[], opts: SearchOptions) {
  const preset = q.region ? REGION_PRESETS[q.region] : undefined;
  let matches: (LocatedCarrier & { state: string })[] = [];
  if (!national) {
    for (const state of states) {
      for (const m of filterCarriers(type === 'partners' ? await loadPartners(state) : await loadCarriers(state, type), { ...q, counties: preset ? areaCounties(preset, state) : undefined }, zipLookup)) matches.push({ ...m, state });
    }
  }
  matches = sortCarriers(matches, q.sort || (type === 'partners' ? 'score' : 'size'), q.near) as typeof matches;
  const toRow = (m: (typeof matches)[number]) => tupleToMover(m.t, m.state, m.lat !== null && m.lng !== null ? [m.lat, m.lng] : null);
  const pageSize = Math.min(Math.max(q.pageSize || 50, 1), opts.all ? 10000 : 200), page = Math.max(q.page || 1, 1);
  return {
    mode: national ? 'national' as const : 'detailed' as const, nationalComplete: undefined, needsArea: national,
    states: national ? summaries.map(s => s.state) : states, total: matches.length,
    rows: matches.slice((page - 1) * pageSize, page * pageSize).map(toRow), all: opts.all ? matches.slice(0, opts.allLimit ?? 20000).map(toRow) : undefined,
    rank: null, explain: null,
    // Shortlist pins are colored by category; single-category pins by fleet size.
    map: opts.points ? registryMap(matches.flatMap((m): MapPoint[] => {
      if (m.lat === null || m.lng === null) return [];
      const point: MapPoint = [m.t[0], m.lat, m.lng, m.t[2] || m.t[1], m.t[8], m.state];
      if (type === 'partners') point.push(CATEGORY_COLOR[primaryCategory(m.t[13])]);
      return [point];
    }), q.bbox, opts.zoom ?? 0) : undefined,
    totals: { units: matches.reduce((n, m) => n + m.t[8], 0), drivers: matches.reduce((n, m) => n + m.t[9], 0) },
    updatedAt: summaries.filter(s => !national ? states.includes(s.state) : true).map(s => s.updatedAt).filter(Boolean).sort().pop() || null,
  };
}
