const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { fetchTiers, getLiveTier } = require('./_shared/tiers');

const MAX_QTY = 5;

// Where Stripe sends the buyer back to. `door` is the at-the-door sales
// flow (staff-facing, e.g. a tablet at the gate) — same event, same
// live tier, just a confirmation page sized for showing qty + email at
// a glance. Everything else falls back to the normal landing-page flow.
// Kept as a fixed lookup (not a raw URL from the client) so this can't
// be used as an open redirect.
const DESTINATIONS = {
  main: { success: '/thank-you.html', cancel: '/index.html' },
  door: { success: '/ticket/confirmed.html', cancel: '/ticket/index.html' }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let qty, dest;
  try {
    const body = JSON.parse(event.body || '{}');
    qty = body.qty;
    dest = DESTINATIONS[body.dest] ? body.dest : 'main';
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_body' }) };
  }

  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_qty' }) };
  }

  try {
    const tiers = await fetchTiers(stripe);
    const live = getLiveTier(tiers);
    if (!live) {
      return { statusCode: 409, body: JSON.stringify({ error: 'sold_out' }) };
    }

    const proto = event.headers['x-forwarded-proto'] || 'https';
    const siteUrl = proto + '://' + event.headers.host;
    const target = DESTINATIONS[dest];
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: live.priceId, quantity: qty }],
      success_url: siteUrl + target.success + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: siteUrl + target.cancel,
      metadata: { qty: String(qty), tier: live.key },
      // Staff at the door apply bundle discount codes (e.g. 100THB-OFF) on
      // Stripe's hosted checkout page itself — no separate UI needed here.
      allow_promotion_codes: dest === 'door'
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'checkout_unavailable' }) };
  }
};
