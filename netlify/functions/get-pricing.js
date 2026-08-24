const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { fetchTiers } = require('./_shared/tiers');

const MAX_QTY = 5;

exports.handler = async () => {
  try {
    const tiers = await fetchTiers(stripe);

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
        maxQty: MAX_QTY
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'pricing_unavailable' }) };
  }
};
