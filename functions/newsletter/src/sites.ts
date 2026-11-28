import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import type { UserRecord } from 'firebase-admin/auth';

export const movingAudiences = ['employees', 'admins', 'providers', 'customers', 'moving-agent-partners'] as const;
export type Audience = 'subscribers' | typeof movingAudiences[number];
const site = { key: 'wontstopmoving', domain: 'wontstopmoving.com', name: 'Wont Stop Moving' } as const;
export type Site = typeof site;

export function newsletterSite(project = process.env.GCLOUD_PROJECT): Site | undefined {
  if (project === 'studio-6652665935-1850d') return site;
}
export const audienceOptions = (_site: Site): readonly Audience[] => movingAudiences;
export const normalizeAddress = (email: string) => email.trim().toLowerCase();
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const subscribersPath = 'newsletterSubscribers';
export const campaignsPath = 'newsletterCampaigns';
export const deliveryPath = 'newsletterDeliveries';

export async function canManage(_site: Site, user: UserRecord): Promise<boolean> {
  if (user.disabled) return false;
  const account = await getFirestore().doc(`users/${user.uid}`).get();
  return account.get('role') === 'admin';
}

export async function audienceFor(_site: Site, uid: string): Promise<Audience | undefined> {
  const db = getFirestore();
  const account = await db.doc(`users/${uid}`).get();
  if (!account.exists) return;
  switch (account.get('role') ?? 'customer') {
    case 'employee': return 'employees';
    case 'admin': return 'admins';
    case 'provider': return 'providers';
    case 'customer': return 'customers';
    case 'agent':
      if ((await db.doc(`agents/${uid}`).get()).get('status') === 'approved') return 'moving-agent-partners';
      return;
    default: return;
  }
}
