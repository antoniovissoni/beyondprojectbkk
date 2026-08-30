const crypto = require('crypto');
const { getPaymentRequest, verifyWebhookSignature } = require('./_shared/hitpay');
const { addGuestWithNextAvailableTicket } = require('./_shared/luma');

const META_PIXEL_ID = '1700836710824786';
const POSTHOG_API_KEY = 'phc_qPgeR9Rb8MqkxNTc7S4HkJDbaKJc6wUfDBVi8Y57VkPR';

function hashEmail(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

async function sendMetaPurchase(record, qty, siteUrl) {
  if (!process.env.META_CAPI_ACCESS_TOKEN) return;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: 'hitpay_' + record.id,
      action_source: 'website',
      event_source_url: siteUrl + '/thank-you.html',
      user_data: record.email ? { em: [hashEmail(record.email)] } : {},
      custom_data: {
        value: Number(record.amount),
        currency: (record.currency || 'thb').toUpperCase(),
        num_items: qty
      }
    }]
  };

  await fetch(
    'https://graph.facebook.com/v20.0/' + META_PIXEL_ID + '/events?access_token=' +
      process.env.META_CAPI_ACCESS_TOKEN,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
}

async function sendPostHogPurchase(record, qty) {
  await fetch('https://us.i.posthog.com/capture/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      event: 'Purchase',
      distinct_id: record.email || record.id,
      properties: {
        value: Number(record.amount),
        currency: (record.currency || 'thb').toUpperCase(),
        num_items: qty,
        payment_request_id: record.id,
        payment_method: 'promptpay'
      }
    })
  });
}

// Throws on failure (unlike the old version) so the caller can make HitPay
// retry the webhook delivery instead of silently losing the ticket — a
// guest that fails to get added here previously left no trace beyond a
// console.error, and HitPay never re-delivered because we always answered
// 200.
async function addLumaGuest(record, qty) {
  if (!process.env.LUMA_API_KEY || !process.env.LUMA_EVENT_ID) {
    throw new Error('Luma not configured (LUMA_API_KEY / LUMA_EVENT_ID missing)');
  }

  // Guests keep landing in the wrong Luma event despite this reading
  // process.env.LUMA_EVENT_ID fresh every call with no caching or fallback —
  // logging the raw value (JSON-stringified so stray whitespace/newlines
  // from a copy-paste into the Netlify UI are visible) to confirm whether
  // the deployed value actually matches what's intended.
  console.log(`LUMA_EVENT_ID as read by this invocation: ${JSON.stringify(process.env.LUMA_EVENT_ID)}`);

  const eventId = process.env.LUMA_EVENT_ID;
  const typesUsed = await addGuestWithNextAvailableTicket(eventId, {
    email: record.email,
    name: record.name,
    qty
  });
  const breakdown = typesUsed.map((t) => t.name).join(', ');
  console.log(`Added ${record.email} to Luma event ${eventId} (${qty}x: ${breakdown}) for HitPay payment ${record.id}`);
}

exports.handler = async (event) => {
  const signature = event.headers['hitpay-signature'] || event.headers['Hitpay-Signature'];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');

  if (!verifyWebhookSignature(rawBody, signature, process.env.HITPAY_WEBHOOK_SALT)) {
    return { statusCode: 400, body: 'invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return { statusCode: 400, body: 'invalid json' };
  }

  if (!payload.id) {
    return { statusCode: 200, body: 'ok' };
  }

  // reference_number is set by create-promptpay-request.js and is
  // customer-uneditable — anything else hitting this webhook (a HitPay
  // payment request created for some other purpose on the same account)
  // is ignored rather than assumed to be a ticket sale.
  const referenceNumber = payload.reference_number || '';
  const match = /^bkk-ticket-qty(\d+)-/.exec(referenceNumber);
  if (!match) {
    console.log(`Ignoring HitPay payment ${payload.id} — reference "${referenceNumber}" isn't this event's ticket.`);
    return { statusCode: 200, body: 'ok' };
  }
  const qty = Number(match[1]);

  // HitPay's webhook payload shape has varied across API/doc versions —
  // re-fetch the payment request directly and trust only its own `status`
  // field rather than the webhook body, before ever granting a Luma ticket.
  let record;
  try {
    record = await getPaymentRequest(payload.id);
  } catch (err) {
    console.error(`Failed to fetch HitPay payment request ${payload.id}:`, err.message);
    return { statusCode: 502, body: 'hitpay lookup failed' };
  }

  if (record.status !== 'completed') {
    return { statusCode: 200, body: 'ok' };
  }

  if (!record.email) {
    console.error('HitPay payment request has no email — cannot add Luma guest for', record.id);
    return { statusCode: 200, body: 'ok' };
  }

  // Luma is the one side effect that must not be silently lost: if it
  // fails, answer with a non-2xx so HitPay's webhook retry logic re-delivers
  // this event later instead of us swallowing the error and never trying
  // again. Meta/PostHog are best-effort analytics — fired only after Luma
  // has actually succeeded, so a hiccup in either of them can never trigger
  // a retry that would risk double-adding the guest.
  try {
    await addLumaGuest(record, qty);
  } catch (err) {
    console.error(`Failed to add Luma guest for HitPay payment ${record.id}:`, err.message);
    return { statusCode: 502, body: 'luma add failed' };
  }

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const siteUrl = proto + '://' + event.headers.host;
  await Promise.all([
    sendMetaPurchase(record, qty, siteUrl).catch((err) =>
      console.error(`Meta CAPI purchase event failed for HitPay payment ${record.id}:`, err.message)
    ),
    sendPostHogPurchase(record, qty).catch((err) =>
      console.error(`PostHog purchase event failed for HitPay payment ${record.id}:`, err.message)
    )
  ]);

  return { statusCode: 200, body: 'ok' };
};
