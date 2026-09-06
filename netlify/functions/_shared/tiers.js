// Fixed tier order: whichever Product is `active` in Stripe is the live
// (purchasable) one. Tiers before it in this order are sold out; tiers
// after it haven't opened yet. Archiving/activating Products in Stripe is
// the only thing that ever needs to change to move between tiers.
// Stripe is the single source of truth here — PromptPay (HitPay) pricing
// and availability are derived from these same tiers, never set independently.
const TIERS = [
  { key: 'early_bird', envVar: 'STRIPE_PRODUCT_EARLY_BIRD' },
  { key: 'regular', envVar: 'STRIPE_PRODUCT_REGULAR' },
  { key: 'final', envVar: 'STRIPE_PRODUCT_FINAL' }
];

async function fetchTiers(stripe) {
  const products = await Promise.all(
    TIERS.map((t) => stripe.products.retrieve(process.env[t.envVar], { expand: ['default_price'] }))
  );

  const liveIndex = products.findIndex((p) => p.active);

  return products.map((p, i) => {
    let status;
    if (liveIndex === -1) status = 'sold';
    else if (i === liveIndex) status = 'live';
    else if (i < liveIndex) status = 'sold';
    else status = 'soon';

    return {
      key: TIERS[i].key,
      status,
      productId: p.id,
      priceId: p.default_price.id,
      unitAmount: p.default_price.unit_amount / 100,
      currency: p.default_price.currency.toUpperCase()
    };
  });
}

function getLiveTier(tiers) {
  return tiers.find((t) => t.status === 'live') || null;
}

// Online bundle pricing: ฿100 off per extra ticket beyond the first
// (2 tickets = ฿100 off, 3 = ฿200 off, ... 5 = ฿400 off). There's no
// coupon beyond the 5-ticket bundle (see bundle-coupon.js), so any
// larger quantity is capped at that same ฿400 — must stay in lock-step
// with bundleCouponName's cap so Card and PromptPay always land on the
// same total for a given qty. Door sales don't get this automatically —
// walk-ups pay full price unless staff apply a promo code on the Stripe
// checkout page.
function getBundleDiscount(qty) {
  return Math.max(0, Math.min(qty, 5) - 1) * 100;
}

module.exports = { fetchTiers, getLiveTier, getBundleDiscount };
