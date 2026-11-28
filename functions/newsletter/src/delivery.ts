import { randomUUID } from 'node:crypto';
import { getFirestore, FieldValue, FieldPath, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { eligibleSubscriber, settingsPath } from './campaigns.js';
import { campaignsPath, deliveryPath, digest, subscribersPath, type Site } from './sites.js';
import { isExplicitThrottle, sendNewsletter } from './sender.js';

const acceptedStates = ['sending', 'accepted', 'delayed', 'delivered', 'bounced', 'complained', 'rejected', 'needs_review'];
const outboxId = (campaignId: string, subscriberId: string) => digest(`${campaignId}:${subscriberId}`);

function unsubscribeUrl(appRegion: string, subscriberId: string, token: string) {
  const url = new URL(`https://${appRegion}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/newsletterFeedback/unsubscribe`);
  url.searchParams.set('id', subscriberId);
  url.searchParams.set('token', token);
  return url;
}

export async function expandCampaign(campaignId: string, after?: string) {
  const db = getFirestore();
  const campaignRef = db.collection(campaignsPath).doc(campaignId);
  const campaign = (await campaignRef.get()).data();
  if (!campaign || campaign.status !== 'queued') return;
  if ((await db.doc(settingsPath).get()).get('enabled') !== true) throw new Error('NEWSLETTER_PAUSED');
  const pageSize = 100;
  const query = db.collection(subscribersPath).where('active', '==', true).orderBy(FieldPath.documentId());
  const page = await (after ? query.startAfter(after) : query).limit(pageSize).get();
  const eligible = page.docs.filter(doc =>
    campaign.audiences.includes(doc.get('audience')) && doc.get('optedInAt')?.toMillis() <= campaign.queuedAt.toMillis());
  await db.runTransaction(async txn => {
    const current = (await txn.get(campaignRef)).data();
    if (!current || current.status !== 'queued') return;
    const remaining = current.expectedCount - (current.enqueuedCount ?? 0);
    if (remaining < 1) return;
    if (!eligible.length) return;
    const refs = eligible.map(doc => db.collection(deliveryPath).doc(outboxId(campaignId, doc.id)));
    const prior = await txn.getAll(...refs);
    const missing = prior.flatMap((doc, index) => doc.exists ? [] : [{ref: doc.ref, subscriberId: eligible[index].id}]);
    const pending = missing.slice(0, remaining);
    pending.forEach(({ref, subscriberId}) => {
      txn.create(ref, {campaignId, subscriberId, status: 'pending', createdAt: FieldValue.serverTimestamp()});
    });
    if (pending.length) txn.update(campaignRef, {enqueuedCount: FieldValue.increment(pending.length)});
  });
  if (page.size < pageSize) {
    await campaignRef.update({fanoutFinishedAt: FieldValue.serverTimestamp()});
    return;
  }
  return page.docs.at(-1)?.id;
}

export async function deliverNewsletter(site: Site, id: string, appRegion: string, sendMail = sendNewsletter) {
  const db = getFirestore(), ref = db.collection(deliveryPath).doc(id);
  const initial = (await ref.get()).data();
  if (!initial || !['pending', 'sending', 'retry'].includes(initial.status)) return;
  if (initial.testOnly === true) return;
  const attemptId = randomUUID();
  const campaignRef = db.collection(campaignsPath).doc(initial.campaignId);
  const subRef = db.collection(subscribersPath).doc(initial.subscriberId);
  const [campaignSnap, subscriberSnap] = await db.getAll(campaignRef, subRef);
  const campaign = campaignSnap.data(), subscriber = subscriberSnap.data();
  const eligible = initial.status !== 'sending' && campaign && subscriber &&
    await eligibleSubscriber(site, subscriber, campaign.audiences);
  let attempts = 0;

  const claim = await db.runTransaction(async txn => {
    const [item, settings, currentCampaign, currentSub, suppression] = await Promise.all([
      txn.get(ref), txn.get(db.doc(settingsPath)), txn.get(campaignRef), txn.get(subRef),
      txn.get(db.doc(`newsletterSuppressions/${initial.subscriberId}`)),
    ]);
    const value = item.data();
    if (!value) return false;
    if (value.status === 'sending') {
      if (value.leaseUntil?.toMillis() > Date.now()) throw new Error('NEWSLETTER_SEND_IN_PROGRESS');
      txn.update(ref, {status: 'needs_review', failure: 'LEASE_EXPIRED', leaseUntil: FieldValue.delete()});
      return false;
    }
    if (!['retry', 'pending'].includes(value.status)) return false;
    if (settings.get('enabled') !== true) throw new Error('NEWSLETTER_PAUSED');
    if (value.nextAttemptAt?.toMillis() > Date.now()) throw new Error('NEWSLETTER_BACKOFF');
    if (eligible && !currentSub.updateTime?.isEqual(subscriberSnap.updateTime!)) throw new Error('NEWSLETTER_PREFERENCE_CHANGED');
    if (currentCampaign.get('status') !== 'queued' || currentSub.get('active') !== true || !eligible || suppression.exists ||
        currentSub.get('optedInAt')?.toMillis() > currentCampaign.get('queuedAt')?.toMillis()) {
      txn.update(ref, {status: 'skipped', resolvedAt: FieldValue.serverTimestamp()});
      return false;
    }
    attempts = (value.attempts ?? 0) + 1;
    txn.update(ref, {status: 'sending', attemptId, attempts, leaseUntil: Timestamp.fromMillis(Date.now() + 120000)});
    return true;
  });
  if (!claim || !campaign || !subscriber) return;
  await sendClaimedDelivery(site, ref, attemptId, {
    recipient: subscriber.email, subject: campaign.subject, text: campaign.text,
    address: campaign.postalAddress,
    unsubscribe: unsubscribeUrl(appRegion, initial.subscriberId, subscriber.unsubscribeToken),
  }, attempts < 5, sendMail);
}

async function sendClaimedDelivery(
  site: Site, ref: DocumentReference, attemptId: string,
  message: Omit<Parameters<typeof sendNewsletter>[1], 'deliveryId' | 'attemptId'>,
  allowThrottleRetry: boolean, sendMail: typeof sendNewsletter,
) {
  const db = getFirestore();
  let providerMessageId: string | undefined;
  let retry = false;
  try {
    providerMessageId = await sendMail(site, {...message, deliveryId: ref.id, attemptId});
  } catch (error) {
    retry = allowThrottleRetry && isExplicitThrottle(error);
  }
  const deferred = await db.runTransaction(async txn => {
    const item = (await txn.get(ref)).data();
    if (item?.attemptId !== attemptId || item.status !== 'sending') return false;
    txn.update(ref, {
      status: providerMessageId ? 'accepted' : retry ? 'retry' : 'needs_review',
      leaseUntil: FieldValue.delete(),
      ...(providerMessageId
        ? {providerMessageId, acceptedAt: FieldValue.serverTimestamp(), failure: FieldValue.delete()}
        : {failure: retry ? 'SES_THROTTLED' : 'POSSIBLE_SEND_FAILURE',
          ...(retry && {nextAttemptAt: Timestamp.fromMillis(Date.now() + 30000 * 2 ** (item.attempts - 1))})}),
    });
    return retry;
  });
  if (deferred) throw new Error('NEWSLETTER_BACKOFF');
}

export async function recordFeedback(site: Site, envelope: {MessageId?: string; Message?: string; TopicArn?: string}) {
  const event = JSON.parse(envelope.Message || 'null');
  const tag = (name: string) => {
    const values = event?.mail?.tags?.[name];
    return Array.isArray(values) && values.length === 1 ? values[0] : null;
  };
  const status = ({
    delivery: 'delivered', bounce: 'bounced', complaint: 'complained', reject: 'rejected', deliverydelay: 'delayed',
  } as Record<string, string>)[String(event?.eventType).toLowerCase().replace(/[^a-z]/g, '')];
  const id = tag('deliveryId'), attempt = tag('attemptId');
  const destinations = event?.mail?.destination;
  const providerMessageId = event?.mail?.messageId;
  if (!status || tag('business') !== site.key || tag('ses:configuration-set') !== `${site.key}-newsletter` ||
    typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || typeof attempt !== 'string' ||
    typeof providerMessageId !== 'string' || !Array.isArray(destinations) || destinations.length !== 1 ||
    typeof destinations[0] !== 'string') return;
  const subscriberId = digest(destinations[0].toLowerCase());
  const db = getFirestore(), ref = db.collection(deliveryPath).doc(id);
  const dedupe = db.doc(`newsletterEvents/${digest(`${envelope.TopicArn}:${envelope.MessageId}`)}`);
  const suppress = !destinations[0].toLowerCase().endsWith('@simulator.amazonses.com') &&
    (status === 'complained' || (status === 'bounced' && event.bounce?.bounceType === 'Permanent'));
  const subscriberRef = db.collection(subscribersPath).doc(subscriberId);
  await db.runTransaction(async txn => {
    const [record, prior] = await Promise.all([txn.get(ref), txn.get(dedupe)]);
    const item = record.data();
    if (prior.exists || !item || item.subscriberId !== subscriberId || item.attemptId !== attempt ||
        (item.providerMessageId && item.providerMessageId !== providerMessageId) || !acceptedStates.includes(item.status)) return;
    const subscriber = suppress ? await txn.get(subscriberRef) : null;
    txn.create(dedupe, {status, deliveryId: id, createdAt: FieldValue.serverTimestamp()});
    const order = ['accepted', 'delayed', 'delivered', 'rejected', 'bounced', 'complained'];
    if (order.indexOf(status) > order.indexOf(item.status)) {
      txn.update(ref, {status, providerMessageId, updatedAt: FieldValue.serverTimestamp(), leaseUntil: FieldValue.delete()});
    }
    if (suppress) {
      txn.set(db.doc(`newsletterSuppressions/${subscriberId}`), {status, updatedAt: FieldValue.serverTimestamp()});
      if (subscriber?.exists) txn.update(subscriberRef, {active: false});
    }
  });
}
