import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import { GoogleAuth } from 'google-auth-library';
import type { Site } from './sites.js';
import { newsletterAwsAccount } from './aws-account.js';

const region = 'us-east-2';
const clients = new Map<string, SESv2Client>();
function getClient(site: Site) {
  const existing = clients.get(site.key);
  if (existing) return existing;
  const role = `${site.key}-ses-newsletter-worker`;
  const sts = new STSClient({region});
  const client = new SESv2Client({
    region, maxAttempts: 1,
    credentials: async () => {
      const token = await new GoogleAuth().getIdTokenClient(role);
      const result = await sts.send(new AssumeRoleWithWebIdentityCommand({
        RoleArn: `arn:aws:iam::${newsletterAwsAccount.value()}:role/${role}`,
        RoleSessionName: role,
        WebIdentityToken: await token.idTokenProvider.fetchIdToken(role),
        DurationSeconds: 900,
      }), {abortSignal: AbortSignal.timeout(10000)});
      const c = result.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('NEWSLETTER_SIGN_IN_FAILED');
      return {accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration};
    },
  });
  clients.set(site.key, client);
  return client;
}

export async function sendNewsletter(site: Site, input: {
  recipient: string; subject: string; text: string; address: string; unsubscribe: URL; deliveryId: string; attemptId: string;
}) {
  const result = await getClient(site).send(new SendEmailCommand({
    FromEmailAddress: `${site.name} <newsletter@${site.domain}>`,
    Destination: {ToAddresses: [input.recipient]},
    ConfigurationSetName: `${site.key}-newsletter`,
    Content: {Simple: {
      Subject: {Data: input.subject, Charset: 'UTF-8'},
      Body: {Text: {Data: `${input.text}\n\n${site.name}\n${input.address}\n\nUnsubscribe: ${input.unsubscribe.href}`, Charset: 'UTF-8'}},
      Headers: [
        {Name: 'List-Unsubscribe', Value: `<${input.unsubscribe.href}>`},
        {Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click'},
      ],
    }},
    EmailTags: [
      {Name: 'business', Value: site.key},
      {Name: 'deliveryId', Value: input.deliveryId},
      {Name: 'attemptId', Value: input.attemptId},
    ],
  }), {abortSignal: AbortSignal.timeout(30000)});
  if (!result.MessageId) throw new Error('NEWSLETTER_MESSAGE_ID_MISSING');
  return result.MessageId;
}

export function isExplicitThrottle(error: unknown) {
  const result = error as {name?: string; $metadata?: {httpStatusCode?: number}} | undefined;
  return result?.$metadata?.httpStatusCode === 429 ||
    (result?.$metadata?.httpStatusCode === 400 && result.name === 'ThrottlingException');
}
