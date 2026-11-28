import { randomBytes } from 'node:crypto';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  audienceFor, audienceOptions, campaignsPath, canManage, deliveryPath, digest, normalizeAddress, subscribersPath, type Audience, type Site,
} from './sites.js';

export const settingsPath = 'newsletterControls/settings';
const defaultCampaignLimit = 1000;
export const documentId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value);

export async function subscription(site: Site, user: UserRecord, action: unknown) {
  if (!user.emailVerified || !user.email || user.disabled) {
    throw new HttpsError('failed-precondition', 'Verify your email address before managing your subscription.');
  }
  const email = normalizeAddress(user.email);
  const db = getFirestore();
  const ref = db.collection(subscribersPath).doc(digest(email));
  const suppression = db.doc(`newsletterSuppressions/${ref.id}`);
  const audience = await audienceFor(site, user.uid);
  if (action === 'status') {
    const [preference, blocked] = await db.getAll(ref, suppression);
    const record = preference.data();
    return { subscribed: record?.uid === user.uid && record?.active === true, email, eligible: Boolean(audience) && !blocked.exists };
  }
  if (action !== 'subscribe' && action !== 'unsubscribe') throw new HttpsError('invalid-argument', 'Choose a subscription action.');
  if (action === 'subscribe' && !audience) throw new HttpsError('failed-precondition', 'Your account is not eligible for a newsletter audience yet.');
  return db.runTransaction(async transaction => {
    const record = (await transaction.get(ref)).data();
    if (action === 'unsubscribe') {
      if (record?.uid === user.uid) transaction.update(ref, {active: false, optedOutAt: FieldValue.serverTimestamp()});
      return {subscribed: false, email, eligible: Boolean(audience)};
    }
    if ((await transaction.get(suppression)).exists) {
      throw new HttpsError('failed-precondition', 'This address is currently blocked from newsletter delivery.');
    }
    if (!record?.active || record.uid !== user.uid || record.audience !== audience) {
      transaction.set(ref, {
        uid: user.uid, email, audience, active: true, optedInAt: FieldValue.serverTimestamp(),
        unsubscribeToken: record?.uid === user.uid && typeof record.unsubscribeToken === 'string'
          ? record.unsubscribeToken : randomBytes(32).toString('hex'),
      });
    }
    return {subscribed: true, email, eligible: true};
  });
}

function campaignInput(site: Site, input: Record<string, unknown>) {
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const allowed = audienceOptions(site);
  const groups = input.audiences;
  if (!subject || /[\r\n]/.test(subject) || subject.length > 150 || !text || text.length > 20000
    || !Array.isArray(groups) || !groups.length || groups.some(group => !allowed.includes(group))) {
    throw new HttpsError('invalid-argument', 'Enter a subject, message, and at least one valid audience.');
  }
  return {subject, text, audiences: Array.from(new Set(groups)) as Audience[]};
}

function view(id: string, campaign: DocumentData) {
  return {
    id, subject: campaign.subject, text: campaign.text, audiences: campaign.audiences,
    status: campaign.status, version: campaign.version, updatedAt: campaign.updatedAt?.toMillis() || 0,
  };
}

export async function manageCampaign(site: Site, user: UserRecord, input: Record<string, unknown>) {
  if (!(await canManage(site, user))) throw new HttpsError('permission-denied', 'Administrator access is required.');
  const db = getFirestore();
  const campaigns = db.collection(campaignsPath);
  if (input.action === 'list') {
    const [recent, settings] = await Promise.all([campaigns.orderBy('updatedAt', 'desc').limit(30).get(), db.doc(settingsPath).get()]);
    return {
      campaigns: recent.docs.map(document => view(document.id, document.data())),
      audiences: audienceOptions(site),
      sendingEnabled: settings.get('enabled') === true && Boolean(settings.get('postalAddress')),
    };
  }
  if (input.action === 'save') {
    const values = campaignInput(site, input);
    if (input.id != null && !documentId(input.id)) throw new HttpsError('invalid-argument', 'Invalid campaign.');
    if (input.id == null) {
      const ref = campaigns.doc(randomBytes(16).toString('hex'));
      await ref.create({...values, status: 'draft', version: 1, createdBy: user.uid,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
      return {id: ref.id, version: 1};
    }
    const ref = campaigns.doc(input.id);
    return db.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data();
      if (!current || current.status !== 'draft' || current.version !== input.version) {
        throw new HttpsError('failed-precondition', 'Draft changed. Refresh before saving again.');
      }
      transaction.update(ref, {...values, version: current.version + 1, updatedAt: FieldValue.serverTimestamp()});
      return {id: ref.id, version: current.version + 1};
    });
  }
  if (input.action === 'results' && documentId(input.id)) {
    const campaign = await campaigns.doc(input.id).get();
    if (campaign.get('status') !== 'queued') throw new HttpsError('failed-precondition', 'Choose a queued campaign.');
    const items = db.collection(deliveryPath).where('campaignId', '==', input.id);
    const states = ['pending', 'retry', 'sending', 'accepted', 'delivered', 'delayed', 'bounced', 'complained', 'rejected', 'needs_review', 'skipped'];
    const totals = await Promise.all(states.map(async status => ({
      status, count: (await items.where('status', '==', status).count().get()).data().count,
    })));
    return {expanded: Boolean(campaign.get('fanoutFinishedAt')), totals: totals.filter(({count}) => count > 0)};
  }

  if (!documentId(input.id) || (input.action !== 'preview' && input.action !== 'queue')) {
    throw new HttpsError('invalid-argument', 'Choose a saved draft.');
  }
  const ref = campaigns.doc(input.id);
  const campaign = (await ref.get()).data();
  if (!campaign || campaign.status !== 'draft' || campaign.version !== input.version) {
    throw new HttpsError('failed-precondition', 'Draft changed. Refresh and preview it again.');
  }
  const confirmed = campaignInput(site, campaign);
  const counts = await Promise.all(confirmed.audiences.map(async audience => {
    const result = await db.collection(subscribersPath).where('active', '==', true).where('audience', '==', audience).count().get();
    return {audience, count: result.data().count};
  }));
  const count = counts.reduce((sum, group) => sum + group.count, 0);
  if (input.action === 'preview') return {counts, count, version: campaign.version};
  if (input.confirmed !== true || input.expectedCount !== count || count < 1) {
    throw new HttpsError('failed-precondition', 'Preview the current audience and confirm the send.');
  }
  return db.runTransaction(async transaction => {
    const [current, settings] = await Promise.all([transaction.get(ref), transaction.get(db.doc(settingsPath))]);
    if (current.get('status') !== 'draft' || current.get('version') !== input.version) {
      throw new HttpsError('failed-precondition', 'This draft has already changed or been queued.');
    }
    const address = settings.get('postalAddress');
    if (settings.get('enabled') !== true || typeof address !== 'string' || !address.trim()) {
      throw new HttpsError('failed-precondition', 'Newsletter sending is off until the sender and mailing address are configured.');
    }
    const configuredLimit = settings.get('maxRecipientsPerCampaign');
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit : defaultCampaignLimit;
    if (count > limit) {
      throw new HttpsError('failed-precondition', `This newsletter exceeds the ${limit}-recipient limit per campaign.`);
    }
    transaction.update(ref, {status: 'queued', queuedBy: user.uid, expectedCount: count, postalAddress: address.trim(),
      queuedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()});
    return {id: ref.id, status: 'queued'};
  });
}

export async function eligibleSubscriber(site: Site, record: DocumentData, groups: Audience[]) {
  if (record.active !== true || typeof record.uid !== 'string' || typeof record.email !== 'string') return false;
  let user: UserRecord;
  try { user = await getAuth().getUser(record.uid); }
  catch (error) {
    if ((error as {code?: string}).code === 'auth/user-not-found') return false;
    throw error;
  }
  if (user.disabled || !user.emailVerified || !user.email || normalizeAddress(user.email) !== record.email) return false;
  const audience = await audienceFor(site, record.uid);
  return audience !== undefined && audience === record.audience && groups.includes(audience);
}
