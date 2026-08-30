const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { fetchTiers, getLiveTier, getBundleDiscount } = require('./_shared/tiers');

const MAX_QTY = 5;

// Same promo codes door staff already type in manually on Stripe's hosted
// checkout (allow_promotion_codes below) — looked up by code so the online
// bundle discount is the exact same Stripe object, not a separately
// computed lump sum. Keeps the real quantity on the line item (Stripe
// shows "3 x ฿600" plus this as its own discount line) instead of folding
// everything into one quantity:1 item priced at the discounted total.
const DISCOUNT_CODES = { 100: '100THB-OFF', 200: '200THB-OFF', 300: '300THB-OFF', 400: '400THB-OFF' };

async function findPromotionCodeId(amountOff) {
  const codeName = DISCOUNT_CODES[amountOff];
  if (!codeName) return null;
  const result = await stripe.promotionCodes.list({ code: codeName, active: true, limit: 1 });
  return result.data[0] ? result.data[0].id : null;
}

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

    // Bundle discount applies online only — door walk-ups pay full price
    // unless staff apply a promo code (allow_promotion_codes below).
    const discount = dest === 'main' ? getBundleDiscount(qty) : 0;
    let lineItem = { price: live.priceId, quantity: qty };
    let discounts;

    if (discount > 0) {
      const promoId = await findPromotionCodeId(discount);
      if (promoId) {
        discounts = [{ promotion_code: promoId }];
      } else {
        // The matching promo code doesn't exist in Stripe — fall back to a
        // lump-sum priced line item so the charged total is still correct,
        // even though the quantity won't display separately in this case.
        lineItem = {
          price_data: {
            currency: live.currency.toLowerCase(),
            product: live.productId,
            unit_amount: Math.round((live.unitAmount * qty - discount) * 100)
          },
          quantity: 1
        };
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      success_url: siteUrl + target.success + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: siteUrl + target.cancel,
      metadata: { qty: String(qty), tier: live.key },
      ...(discounts
        ? { discounts }
        // Staff at the door apply bundle discount codes (e.g. 100THB-OFF) on
        // Stripe's hosted checkout page itself — no separate UI needed here.
        // (Stripe rejects passing both discounts and allow_promotion_codes.)
        : { allow_promotion_codes: dest === 'door' })
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
