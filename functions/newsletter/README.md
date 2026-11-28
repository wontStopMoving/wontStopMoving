# WontStopMoving newsletter worker

This Firebase Functions codebase serves the public newsletter signup page and admin campaign dashboard. It uses the WontStopMoving Firebase Auth and Firestore project. Subscribers opt in explicitly and can unsubscribe through the website or a campaign email. SES sends through a dedicated configuration set. Signed SNS feedback records delivery, bounces and complaints in Firestore.

## Test locally

From this directory, run these commands with Node 22 and the Firebase CLI. Tests use isolated Auth and Firestore emulators and a stub email transport.

```sh
npm ci
firebase emulators:exec --project demo-website-ses --config firebase.emulator.json --only auth,firestore 'npm test'
```

## Reproduce the WontStopMoving deployment

Use the existing Firebase project `studio-6652665935-1850d` in `us-central1` and newsletter infrastructure in AWS `us-east-2`. The [CloudFormation template](ses-newsletter.yaml) describes the SES, SNS and IAM resources. Use the existing stack and review a change set before modifying its parameters.

Provide the following Firebase parameters in your ignored `.env.studio-6652665935-1850d` file.

| Parameter | Value |
| --- | --- |
| `NEWSLETTER_REGION` | `us-central1` |
| `NEWSLETTER_API_ACCOUNT` | Existing newsletter API service account email |
| `NEWSLETTER_DELIVERY_ACCOUNT` | Existing newsletter worker service account email |
| `NEWSLETTER_DISPATCH_ACCOUNT` | Existing newsletter task identity email |
| `NEWSLETTER_AWS_ACCOUNT_ID` | AWS account that owns the SES role and SNS topic |

Run this scoped command from this directory after verifying the Firebase project and existing IAM bindings.

```sh
firebase deploy --config firebase.json --project studio-6652665935-1850d --only functions:website-newsletters
```

After deployment, confirm the existing dispatcher can enqueue and invoke the private worker, and the worker can enqueue additional pages and assume the dedicated SES role. Check the existing SNS HTTPS subscription targets `newsletterFeedback` and the worker has no public invocation grant. Keep ordinary campaign sending paused by leaving `newsletterControls/settings.enabled` false and the SES configuration set disabled. The finished one-off production email test used a dedicated pilot route, which this version retires.
