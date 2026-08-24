const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
  if (!sessionId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_session_id' }) };
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paid: true,
        qty: Number(session.metadata.qty),
        amount: session.amount_total / 100,
        currency: session.currency.toUpperCase(),
        email: (session.customer_details && session.customer_details.email) || null
      })
    };
  } catch (err) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
};
