# Financing at checkout (Affirm)

Our Checkout sessions don't list `payment_method_types`, so Stripe shows every
payment method that's turned on in the Dashboard. That makes buy-now-pay-later
a settings change, not a code change.

1. Stripe Dashboard → Settings → Payment methods → turn on **Affirm** for the
   platform account (not the connected mover accounts). Affirm is on as of
   2026-11-28. Klarna can be added the same way; then add it to the wording in
   `src/components/dashboard/financing-note.tsx`.
2. Set `NEXT_PUBLIC_FINANCING_ENABLED=1` in App Hosting (apphosting.yaml or the
   console) and redeploy. This shows the "Pay over time" note next to move prices.
3. Test with a quote over $300 in test mode: the Checkout page should offer Affirm.

Notes
- We're paid in full up front; the lender takes the repayment risk. Stripe's
  fee for these methods is higher than for cards (see Stripe's pricing page).
- Affirm needs at least $50 and Klarna has its own limits. Stripe hides a method
  when an order doesn't qualify.
- Payouts to movers are unchanged: they're based on the move price, not the payment method.
- Some financed payments confirm a moment later. The webhook already handles
  `checkout.session.async_payment_succeeded` and `..._failed`.
- Move checkouts save the customer's card for extra hours, but only cards
  (`payment_method_options.card.setup_future_usage`). Saving for every method
  would make Stripe hide Affirm. A move paid with Affirm has no saved card, so
  extra hours for it go through support.
