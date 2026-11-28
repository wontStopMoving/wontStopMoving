import { Timestamp } from 'firebase-admin/firestore';
import { stripe } from '@/lib/stripe';
import { adminDb } from './firebase-admin';

/**
 * The Stripe customer used to save a booking card for extra hours the customer
 * approves later (#153). The id lives server-only in stripeCustomers/{uid}, not
 * on the user's profile.
 */
export async function savedCardCustomer(uid: string, email: string | undefined) {
  const ref = adminDb().doc(`stripeCustomers/${uid}`);
  const existing = (await ref.get()).data()?.id as string | undefined;
  if (existing) return existing;
  const id = (await stripe.customers.create({ email, metadata: { uid } }, { idempotencyKey: `customer-${uid}` })).id;
  await ref.set({ id, createdAt: Timestamp.now() });
  return id;
}

export const SAVED_CARD_NOTE = 'If you pay by card, it is saved securely so you can approve extra hours from the app if your crew needs more time. It is only charged when you tap Accept.';
/**
 * Save the card for extra hours (#153) without hiding financing: a session-wide
 * setup_future_usage makes Stripe drop Affirm, which can't be charged again.
 */
export const SAVE_CARD_ONLY = { card: { setup_future_usage: 'off_session' as const } };
