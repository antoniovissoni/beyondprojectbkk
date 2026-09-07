const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { fetchTiers, getLiveTier } = require('./_shared/tiers');
const { findBundleCoupon } = require('./_shared/bundle-coupon');

const MAX_QTY = 5;

exports.handler = async () => {
  try {
    const tiers = await fetchTiers(stripe);
    const live = getLiveTier(tiers);

    const discounts = {};
    if (live) {
      await Promise.all(
        Array.from({ length: MAX_QTY - 1 }, (_, i) => i + 2).map(async (qty) => {
          const coupon = await findBundleCoupon(stripe, qty);
          if (coupon && coupon.amount_off) discounts[qty] = coupon.amount_off / 100;
        })
      );
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({
        tiers: tiers.map((t) => ({
          key: t.key,
          status: t.status,
          unitAmount: t.unitAmount,
          currency: t.currency
        })),
        maxQty: MAX_QTY,
        discounts: discounts
      })
    };
  } catch (err) {
    console.error('get-pricing failed:', err.type || err.name, err.code, err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'pricing_unavailable' }) };
  }
};
