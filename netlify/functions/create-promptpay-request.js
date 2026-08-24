const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { fetchTiers, getLiveTier, getBundleDiscount } = require('./_shared/tiers');
const { createPaymentRequest } = require('./_shared/hitpay');

const MAX_QTY = 5;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let qty, email, name;
  try {
    const body = JSON.parse(event.body || '{}');
    qty = body.qty;
    email = body.email;
    name = body.name;
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_body' }) };
  }

  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_qty' }) };
  }

  try {
    // Stripe is the single source of truth for tier availability and price.
    // PromptPay must never be able to sell a tier Stripe has sold out, and
    // must always charge whatever Stripe's live tier currently charges.
    const tiers = await fetchTiers(stripe);
    const live = getLiveTier(tiers);
    if (!live) {
      return { statusCode: 409, body: JSON.stringify({ error: 'sold_out' }) };
    }

    const proto = event.headers['x-forwarded-proto'] || 'https';
    const siteUrl = proto + '://' + event.headers.host;

    // reference_number is customer-uneditable and lets the webhook identify
    // "this is a ticket purchase from this site" plus recover qty, without
    // trusting anything else in the (possibly minimal) webhook payload.
    const referenceNumber = 'bkk-ticket-qty' + qty + '-' + crypto.randomBytes(6).toString('hex');

    // Same bundle discount as the card path (getBundleDiscount) — PromptPay
    // must always land on the identical total for the same quantity.
    const request = await createPaymentRequest({
      amount: live.unitAmount * qty - getBundleDiscount(qty),
      currency: live.currency,
      email,
      name,
      referenceNumber,
      redirectUrl: siteUrl + '/thank-you.html'
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: request.url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'checkout_unavailable' }) };
  }
};
