import { defineString } from 'firebase-functions/params';

export const newsletterAwsAccount = defineString('NEWSLETTER_AWS_ACCOUNT_ID', {
  description: 'AWS account containing the WontStopMoving newsletter SES role and SNS topic',
  input: { text: { validationRegex: '^\\d{12}$' } },
});
