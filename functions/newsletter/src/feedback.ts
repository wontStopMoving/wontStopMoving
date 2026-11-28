import MessageValidator from 'sns-validator';
import type { Site } from './sites.js';
import { newsletterAwsAccount } from './aws-account.js';

export type SnsMessage = {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Message?: string;
  SubscribeURL?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
  Timestamp?: string;
  Token?: string;
  Subject?: string;
};

type SnsValidator = { validate(message: Record<string, unknown>, callback: (error: Error | null) => void): void };
const SNS_HOST = 'sns.us-east-2.amazonaws.com';
export class SesFeedbackInputError extends Error {}

export async function validateSnsMessage(site: Site, message: SnsMessage, validator: SnsValidator = new MessageValidator()) {
  if (!message?.TopicArn || message.TopicArn !== `arn:aws:sns:us-east-2:${newsletterAwsAccount.value()}:${site.key}-newsletter-events`) throw new SesFeedbackInputError('SNS_TOPIC_NOT_ALLOWED');
  if (!['Notification', 'SubscriptionConfirmation'].includes(message.Type || '')) throw new SesFeedbackInputError('SNS_MESSAGE_TYPE_NOT_ALLOWED');
  if (message.SignatureVersion !== '2') throw new SesFeedbackInputError('SNS_SIGNATURE_VERSION_INVALID');
  if (typeof message.SigningCertURL !== 'string' || !message.SigningCertURL.startsWith(`https://${SNS_HOST}/`) ||
      !/^SimpleNotificationService-[a-f0-9]+\.pem$/i.test(message.SigningCertURL.slice(`https://${SNS_HOST}/`.length))) {
    throw new SesFeedbackInputError('SNS_SIGNING_CERT_INVALID');
  }
  const { Type, TopicArn, MessageId, Message, Timestamp, Signature, SignatureVersion, SigningCertURL, SubscribeURL, Token, Subject } = message;
  if (![MessageId, Message, Timestamp, Signature].every(value => typeof value === 'string' && value.length > 0) ||
      (Type === 'SubscriptionConfirmation' && ![SubscribeURL, Token].every(value => typeof value === 'string' && value.length > 0)) ||
      (Subject !== undefined && typeof Subject !== 'string')) throw new SesFeedbackInputError('SNS_BODY_INVALID');
  // Pass only canonical HTTP envelope fields to the validator.
  const envelope = { Type, TopicArn, MessageId, Message, Timestamp, Signature, SignatureVersion, SigningCertURL,
    ...(Type === 'SubscriptionConfirmation' ? { SubscribeURL, Token } : {}), ...(Subject !== undefined ? { Subject } : {}) };
  await new Promise<void>((resolve, reject) => validator.validate(envelope, error => {
    if (!error) return resolve();
    if (error.message === 'Certificate could not be retrieved' || 'code' in error) return reject(error);
    reject(new SesFeedbackInputError('SNS_SIGNATURE_INVALID'));
  }));
  return message;
}

function confirmedSubscriptionUrl(message: SnsMessage) {
  let url: URL;
  try { url = new URL(message.SubscribeURL || ''); } catch { throw new SesFeedbackInputError('SNS_SUBSCRIBE_URL_INVALID'); }
  if (url.origin !== `https://${SNS_HOST}` || url.username || url.password || url.hash || url.pathname !== '/' ||
      url.searchParams.size !== 3 || url.searchParams.get('Action') !== 'ConfirmSubscription' ||
      url.searchParams.get('TopicArn') !== message.TopicArn || !message.Token || url.searchParams.get('Token') !== message.Token) {
    throw new SesFeedbackInputError('SNS_SUBSCRIBE_URL_INVALID');
  }
  return url;
}

export async function confirmSnsSubscription(message: SnsMessage) {
  const url = confirmedSubscriptionUrl(message);
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('SNS_SUBSCRIPTION_CONFIRMATION_FAILED');
}
