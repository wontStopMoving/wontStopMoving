import { randomInt } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin';
import { matchesLookup, type LookupHit } from '../account-lookup';

/**
 * Account numbers (#187): short, phone-friendly IDs like WSM-48213 that staff
 * can read aloud, never the Firebase UID. Stored on users/{uid}.accountNumber,
 * with accountNumbers/{number} as the uniqueness claim. Assigned server-side only.
 */
export async function accountNumberFor(uid: string): Promise<string> {
  const db = adminDb(), userRef = db.doc(`users/${uid}`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `WSM-${randomInt(10000, 100000)}`;
    const result = await db.runTransaction(async tx => {
      const user = await tx.get(userRef);
      if (!user.exists) return null;
      const existing = user.data()?.accountNumber;
      if (typeof existing === 'string' && existing) return existing;
      const claim = db.doc(`accountNumbers/${candidate}`);
      if ((await tx.get(claim)).exists) return '';
      tx.create(claim, { uid, createdAt: FieldValue.serverTimestamp() });
      tx.update(userRef, { accountNumber: candidate });
      return candidate;
    });
    if (result === null) throw new Error('No account profile.');
    if (result) return result;
  }
  throw new Error('Could not assign an account number. Try again.');
}

/** One-time backfill: every customer and provider without a number gets one. */
export async function backfillAccountNumbers(deadline = Date.now() + 45_000) {
  const snap = await adminDb().collection('users').where('role', 'in', ['customer', 'provider']).select('accountNumber').get();
  const missing = snap.docs.filter(d => !d.data().accountNumber);
  let assigned = 0;
  for (const d of missing) {
    if (Date.now() > deadline) break;
    await accountNumberFor(d.id); assigned++;
  }
  return { assigned, remaining: missing.length - assigned, total: snap.size };
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const addressText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).filter(x => typeof x === 'string').join(', ');
  return '';
};

/**
 * Staff lookup: customers and providers by phone (any formatting, or the last
 * 4+ digits), name, company, street address, email or account number. Customer
 * addresses come from their jobs; provider addresses from their profile.
 */
export async function staffLookup(q: string): Promise<LookupHit[]> {
  const db = adminDb();
  const [users, providers, jobs] = await Promise.all([
    db.collection('users').where('role', 'in', ['customer', 'provider']).select('name', 'email', 'phone', 'role', 'accountNumber', 'displayName').get(),
    db.collection('providers').select('businessName', 'name', 'email', 'phone', 'address', 'city', 'state').get(),
    db.collection('jobs').orderBy('createdAt', 'desc').limit(5000).select('customerId', 'pickupAddress', 'dropoffAddress', 'customerPhone', 'phone').get().catch(() => null),
  ]);
  const prov = new Map(providers.docs.map(d => [d.id, d.data()]));
  const jobInfo = new Map<string, { addresses: Set<string>; phones: Set<string> }>();
  for (const j of jobs?.docs || []) {
    const x = j.data(), id = text(x.customerId);
    if (!id) continue;
    const info = jobInfo.get(id) || { addresses: new Set<string>(), phones: new Set<string>() };
    for (const a of [x.pickupAddress, x.dropoffAddress]) { const s = addressText(a); if (s) info.addresses.add(s); }
    for (const p of [x.customerPhone, x.phone]) if (text(p)) info.phones.add(text(p));
    jobInfo.set(id, info);
  }
  const hits: LookupHit[] = [];
  for (const u of users.docs) {
    const x = u.data(), role = x.role === 'provider' ? 'provider' : 'customer';
    const p = role === 'provider' ? prov.get(u.id) : undefined;
    const info = jobInfo.get(u.id);
    const candidate = {
      uid: u.id, role, accountNumber: text(x.accountNumber),
      name: text(x.name) || text(x.displayName) || text(p?.name), company: text(p?.businessName), email: text(x.email) || text(p?.email),
      phones: [text(x.phone), text(p?.phone), ...(info?.phones || [])].filter(Boolean),
      addresses: [addressText(p?.address), p?.city ? `${text(p.city)}, ${text(p.state)}` : '', ...(info?.addresses || [])].filter(Boolean),
    } as const;
    const match = matchesLookup(candidate, q);
    if (match) hits.push({ ...candidate, phones: [...new Set(candidate.phones)].slice(0, 3), addresses: [...new Set(candidate.addresses)].slice(0, 3), matched: match });
  }
  const order = { account: 0, phone: 1, email: 2, name: 3, company: 3, address: 4 } as const;
  return hits.sort((a, b) => order[a.matched] - order[b.matched] || a.name.localeCompare(b.name)).slice(0, 50);
}
