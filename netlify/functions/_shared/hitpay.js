const crypto = require('crypto');

// HITPAY_ENV=sandbox talks to the sandbox API (a separate business account,
// separate API key/salt, separate https://sandbox.hit-pay.com dashboard).
// Any other value (or unset) means live. Keep in sync with STRIPE_SECRET_KEY
// being a test/live key — the two rails should point at the same environment
// at the same time.
const HITPAY_API_BASE =
  process.env.HITPAY_ENV === 'sandbox' ? 'https://api.sandbox.hit-pay.com' : 'https://api.hit-pay.com';

async function hitpayPost(path, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    body.append(key, value);
  }

  const res = await fetch(HITPAY_API_BASE + path, {
    method: 'POST',
    headers: {
      'X-BUSINESS-API-KEY': process.env.HITPAY_API_KEY,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!res.ok) throw new Error(`HitPay API ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function hitpayGet(path) {
  const res = await fetch(HITPAY_API_BASE + path, {
    headers: { 'X-BUSINESS-API-KEY': process.env.HITPAY_API_KEY, accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`HitPay API ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Creates a HitPay Payment Request for the live Stripe tier's current price
// (amount is computed by the caller from Stripe, never a stored/static value)
// and returns the hosted checkout url to redirect the buyer to.
async function createPaymentRequest({ amount, currency, email, name, referenceNumber, redirectUrl }) {
  return hitpayPost('/v1/payment-requests', {
    amount: amount.toFixed(2),
    currency,
    email,
    name,
    reference_number: referenceNumber,
    redirect_url: redirectUrl,
    'payment_methods[]': 'promptpay'
  });
}

async function getPaymentRequest(id) {
  return hitpayGet(`/v1/payment-requests/${encodeURIComponent(id)}`);
}

// HitPay signs event-webhook deliveries with HMAC-SHA256 of the raw request
// body, keyed with the *webhook endpoint's own salt* (set when the webhook
// is registered under Developers → Webhooks in the HitPay dashboard — this
// is a different salt from the one shown next to the API key).
function verifyWebhookSignature(rawBody, signature, salt) {
  if (!signature || !salt) return false;
  const computed = crypto.createHmac('sha256', salt).update(rawBody).digest('hex');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createPaymentRequest, getPaymentRequest, verifyWebhookSignature };
