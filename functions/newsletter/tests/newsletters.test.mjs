import assert from 'node:assert/strict';
import {test} from 'node:test';
import {initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {manageCampaign, settingsPath, subscription} from '../lib/campaigns.js';
import {deliverNewsletter, expandCampaign, recordFeedback} from '../lib/delivery.js';
import {audienceOptions, digest, newsletterSite} from '../lib/sites.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Run newsletter tests with the Auth and Firestore emulators.');
}
const projectId = 'demo-website-ses';
process.env.GCLOUD_PROJECT = projectId;
initializeApp({projectId});
const db = getFirestore();
const auth = getAuth();
const site = newsletterSite('studio-6652665935-1850d');

async function member(role, verified = true) {
  const uid = `newsletter-${role}`;
  await db.doc(`users/${uid}`).set({role});
  return auth.createUser({uid, email: `${role}@example.com`, emailVerified: verified});
}
const draft = (audiences) => ({action: 'save', subject: 'A test newsletter', text: 'A sample newsletter.', audiences});
const topic = 'arn:aws:sns:us-east-2:123456789012:wontstopmoving-newsletter-events';

test('verified subscription, five audiences, campaign confirmation, deduplicated delivery and feedback', async () => {
  const [admin, customer, employee, partner, provider] = await Promise.all([
    member('admin'), member('customer'), member('employee'), member('agent'), member('provider', false),
  ]);
  assert.deepEqual(audienceOptions(site), ['employees', 'admins', 'providers', 'customers', 'moving-agent-partners']);
  await assert.rejects(manageCampaign(site, customer, {action: 'list'}), {code: 'permission-denied'});
  await assert.rejects(subscription(site, provider, 'subscribe'), {code: 'failed-precondition'});
  await assert.rejects(subscription(site, partner, 'subscribe'), {code: 'failed-precondition'});
  await db.doc(`agents/${partner.uid}`).set({status: 'approved'});
  await Promise.all([admin, customer, employee, partner].map(user => subscription(site, user, 'subscribe')));
  await auth.updateUser(provider.uid, {emailVerified: true});
  await subscription(site, await auth.getUser(provider.uid), 'subscribe');

  const {id, version} = await manageCampaign(site, admin, draft(['customers', 'moving-agent-partners']));
  const request = (action, data) => manageCampaign(site, admin, {action, id, version, ...data});
  assert.deepEqual((await request('preview')).counts, [{audience: 'customers', count: 1}, {audience: 'moving-agent-partners', count: 1}]);
  const confirmation = {expectedCount: 2, confirmed: true};
  await assert.rejects(request('queue', confirmation), {code: 'failed-precondition'});
  await db.doc(settingsPath).set({enabled: true, postalAddress: 'Emulator fixture mailing address', maxRecipientsPerCampaign: 1});
  await assert.rejects(request('queue', confirmation), {code: 'failed-precondition'});
  await db.doc(settingsPath).update({maxRecipientsPerCampaign: 10});
  await assert.rejects(request('queue', {expectedCount: 1, confirmed: true}), {code: 'failed-precondition'});
  assert.equal((await request('queue', confirmation)).status, 'queued');
  await assert.rejects(request('queue', confirmation), {code: 'failed-precondition'});

  await expandCampaign(id);
  await expandCampaign(id);
  const deliveries = await db.collection('newsletterDeliveries').where('campaignId', '==', id).get();
  assert.equal(deliveries.size, 2);
  await subscription(site, partner, 'unsubscribe');
  const calls = [];
  const send = async (_site, data) => { calls.push(data); return 'provider-test-message'; };
  for (const delivery of deliveries.docs) {
    await deliverNewsletter(site, delivery.id, 'us-central1', send);
    await deliverNewsletter(site, delivery.id, 'us-central1', send);
  }
  assert.equal(calls.length, 1);
  const [sent] = calls;
  assert.equal(sent.recipient, customer.email);
  assert.equal(sent.unsubscribe.searchParams.get('id'), digest(customer.email));
  assert.match(sent.unsubscribe.searchParams.get('token'), /^[a-f0-9]{64}$/);

  const envelope = (MessageId, eventType) => ({
    TopicArn: topic, MessageId,
    Message: JSON.stringify({eventType, mail: {messageId: 'provider-test-message', destination: [customer.email], tags: {
      'ses:configuration-set': ['wontstopmoving-newsletter'], business: ['wontstopmoving'], deliveryId: [sent.deliveryId], attemptId: [sent.attemptId],
    }}}),
  });
  await recordFeedback(site, envelope('delivery-feedback', 'Delivery'));
  await recordFeedback(site, envelope('delivery-feedback', 'Delivery'));
  await recordFeedback(site, envelope('delay-feedback', 'DeliveryDelay'));
  const delivery = db.doc(`newsletterDeliveries/${sent.deliveryId}`);
  assert.equal((await delivery.get()).get('status'), 'delivered');
  assert.equal((await db.collection('newsletterEvents').where('deliveryId', '==', sent.deliveryId).get()).size, 2);
  await recordFeedback(site, envelope('complaint-feedback', 'Complaint'));
  assert.equal((await delivery.get()).get('status'), 'complained');
  assert.equal((await subscription(site, customer, 'status')).subscribed, false);
  await assert.rejects(subscription(site, customer, 'subscribe'), {code: 'failed-precondition'});
  assert.deepEqual(await request('results'), {
    expanded: true,
    totals: [{status: 'complained', count: 1}, {status: 'skipped', count: 1}],
  });
});

test('regular newsletter delivery cannot send while campaigns are paused', async () => {
  await db.doc(settingsPath).set({enabled: false});
  const id = digest('paused-regular-delivery');
  await db.doc(`newsletterDeliveries/${id}`).set({
    status: 'pending', campaignId: digest('paused-campaign'), subscriberId: digest('regular-subscriber'),
  });
  await assert.rejects(deliverNewsletter(site, id, 'us-central1', async () => {
    assert.fail('A paused campaign must not send');
  }), /NEWSLETTER_PAUSED/);
  assert.equal((await db.doc(`newsletterDeliveries/${id}`).get()).get('status'), 'pending');
});
