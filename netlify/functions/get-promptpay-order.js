const { getPaymentRequest } = require('./_shared/hitpay');

// HitPay redirects the buyer back with ?reference=<payment_request_id>&status=...
// but that redirect isn't trustworthy on its own (anyone can hit this URL
// with any id) — always re-fetch the payment request from HitPay and read
// its own `status` field before treating an order as paid.
exports.handler = async (event) => {
  const id = event.queryStringParameters && event.queryStringParameters.reference;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_reference' }) };
  }

  try {
    const record = await getPaymentRequest(id);

    if (record.status !== 'completed') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false })
      };
    }

    const match = /^bkk-ticket-qty(\d+)-/.exec(record.reference_number || '');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paid: true,
        qty: match ? Number(match[1]) : null,
        amount: Number(record.amount),
        currency: (record.currency || 'thb').toUpperCase(),
        email: record.email || null
      })
    };
  } catch (err) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
};
