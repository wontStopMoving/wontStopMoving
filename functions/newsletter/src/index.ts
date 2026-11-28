import { timingSafeEqual } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { defineString } from 'firebase-functions/params';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { documentId, manageCampaign, subscription } from './campaigns.js';
import { deliverNewsletter, expandCampaign, recordFeedback } from './delivery.js';
import { confirmSnsSubscription, SesFeedbackInputError, validateSnsMessage } from './feedback.js';
import { campaignsPath, deliveryPath, digest, newsletterSite, subscribersPath } from './sites.js';

initializeApp();
const region = defineString('NEWSLETTER_REGION');
const apiAccount = defineString('NEWSLETTER_API_ACCOUNT');
const deliveryAccount = defineString('NEWSLETTER_DELIVERY_ACCOUNT');
const dispatcher = defineString('NEWSLETTER_DISPATCH_ACCOUNT');

function siteOrThrow() {
  const site = newsletterSite();
  if (!site) throw new HttpsError('failed-precondition', 'Newsletter is not configured for this website.');
  return site;
}
async function account(uid: string | undefined) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  return getAuth().getUser(uid);
}

export const newsletterSubscription = onCall({region, serviceAccount: apiAccount}, async req => {
  return subscription(siteOrThrow(), await account(req.auth?.uid), req.data?.action);
});

export const newsletterAdmin = onCall({region, serviceAccount: apiAccount}, async req => {
  return manageCampaign(siteOrThrow(), await account(req.auth?.uid), req.data ?? {});
});

type Task = {kind: 'expand' | 'send'; id: string; after?: string};
async function dispatch(task: Task) {
  const queue = getFunctions().taskQueue<Task>(`locations/${region.value()}/functions/newsletterWork`);
  try {
    await queue.enqueue(task, {id: digest(JSON.stringify(task)), dispatchDeadlineSeconds: 120});
  } catch (error) {
    if ((error as {code?: string}).code !== 'functions/task-already-exists') throw error;
  }
}

export const newsletterDispatchCampaign = onDocumentUpdated({
  document: `${campaignsPath}/{id}`, region, serviceAccount: dispatcher, retry: true,
}, async event => {
  if (newsletterSite() && event.data?.before.get('status') === 'draft' && event.data.after.get('status') === 'queued') {
    await dispatch({kind: 'expand', id: event.params.id});
  }
});

export const newsletterDispatchDelivery = onDocumentCreated({
  document: `${deliveryPath}/{id}`, region, serviceAccount: dispatcher, retry: true,
}, async event => {
  if (newsletterSite() && event.data?.get('status') === 'pending') {
    await dispatch({kind: 'send', id: event.params.id});
  }
});

export const newsletterWork = onTaskDispatched<Task>({
  region, invoker: 'private', serviceAccount: deliveryAccount, maxInstances: 1, timeoutSeconds: 90,
  rateLimits: {maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1},
  retryConfig: {maxAttempts: 30, minBackoffSeconds: 30, maxBackoffSeconds: 3600, maxDoublings: 6},
}, async req => {
  const site = siteOrThrow(), task = req.data;
  if (!task || !documentId(task.id)) return;
  if (task.kind === 'send') await deliverNewsletter(site, task.id, region.value());
  if (task.kind === 'expand' && (task.after === undefined || documentId(task.after))) {
    const cursor = await expandCampaign(task.id, task.after);
    if (cursor) await dispatch({kind: 'expand', id: task.id, after: cursor});
  }
});

export const newsletterFeedback = onRequest({region, serviceAccount: apiAccount, invoker: 'public', maxInstances: 3}, async (req, res) => {
  if (req.path === '/unsubscribe') {
    await unsubscribe(req, res);
    return;
  }
  if (req.path !== '/') { res.sendStatus(404); return; }
  if (req.method !== 'POST') { res.sendStatus(405); return; }
  if (req.rawBody.length > 1024 * 1024) { res.sendStatus(413); return; }
  try {
    const site = siteOrThrow();
    let event;
    try { event = JSON.parse(req.rawBody.toString('utf8')); }
    catch { res.sendStatus(400); return; }
    const message = await validateSnsMessage(site, event);
    if (message.Type === 'SubscriptionConfirmation') await confirmSnsSubscription(message);
    else await recordFeedback(site, message);
    res.sendStatus(204);
  } catch (error) {
    res.sendStatus(error instanceof SesFeedbackInputError ? 400 : 503);
  }
});

const unsubscribe: Parameters<typeof onRequest>[0] = async (req, res) => {
  if (!newsletterSite()) { res.sendStatus(404); return; }
  res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
  if (req.method === 'GET') {
    res.type('html').send('<!doctype html><html lang="en"><title>Unsubscribe</title><h1>Unsubscribe from this newsletter</h1><form method="post"><button name="List-Unsubscribe" value="One-Click">Unsubscribe</button></form></html>');
    return;
  }
  if (req.method !== 'POST') { res.sendStatus(405); return; }
  if (req.rawBody.length > 1024 || req.body?.['List-Unsubscribe'] !== 'One-Click') {
    res.sendStatus(400); return;
  }
  const {id, token} = req.query;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) ||
      typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) { res.sendStatus(400); return; }
  const db = getFirestore(), ref = db.collection(subscribersPath).doc(id);
  const matched = await db.runTransaction(async txn => {
    const current = (await txn.get(ref)).data();
    const actual = current?.unsubscribeToken;
    if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual) ||
        !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(token, 'hex'))) return false;
    if (current?.active === true) txn.update(ref, {active: false, optedOutAt: FieldValue.serverTimestamp()});
    return true;
  });
  res.status(matched ? 200 : 404).type('text/plain').send(matched ? 'You are unsubscribed.' : 'This unsubscribe link is unavailable.');
};
