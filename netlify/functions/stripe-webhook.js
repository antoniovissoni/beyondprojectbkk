const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { addTicketsForBuyer } = require('./_shared/luma');

const META_PIXEL_ID = '1700836710824786';
const POSTHOG_API_KEY = 'phc_qPgeR9Rb8MqkxNTc7S4HkJDbaKJc6wUfDBVi8Y57VkPR';

// Stripe webhooks fire for every event on the whole account/mode, not just
// sessions this site's own code created — if this Stripe account is shared
// with other BEYOND city sites, their checkout sessions land here too.
// Cross-check against this site's own configured product IDs before ever
// treating a session as "this event's ticket".
const TICKET_PRODUCT_IDS = [
  process.env.STRIPE_PRODUCT_EARLY_BIRD,
  process.env.STRIPE_PRODUCT_REGULAR,
  process.env.STRIPE_PRODUCT_FINAL
].filter(Boolean);

async function getSessionProductIds(session) {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ['data.price.product']
  });
  return lineItems.data
    .map((li) => li.price && li.price.product)
    .map((product) => (typeof product === 'string' ? product : product && product.id))
    .filter(Boolean);
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

async function sendMetaPurchase(session, siteUrl) {
  if (!process.env.META_CAPI_ACCESS_TOKEN) return;
  const email = session.customer_details && session.customer_details.email;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: session.id,
      action_source: 'website',
      event_source_url: siteUrl + '/thank-you.html',
      user_data: email ? { em: [hashEmail(email)] } : {},
      custom_data: {
        value: session.amount_total / 100,
        currency: session.currency.toUpperCase(),
        num_items: Number(session.metadata.qty)
      }
    }]
  };

  await fetch(
    'https://graph.facebook.com/v20.0/' + META_PIXEL_ID + '/events?access_token=' +
      process.env.META_CAPI_ACCESS_TOKEN,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
}

async function sendPostHogPurchase(session) {
  const email = session.customer_details && session.customer_details.email;

  await fetch('https://us.i.posthog.com/capture/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      event: 'Purchase',
      distinct_id: email || session.id,
      properties: {
        value: session.amount_total / 100,
        currency: session.currency.toUpperCase(),
        num_items: Number(session.metadata.qty),
        session_id: session.id
      }
    })
  });
}

async function addLumaGuest(session) {
  if (!process.env.LUMA_API_KEY || !process.env.LUMA_EVENT_ID) {
    console.error('Luma not configured (LUMA_API_KEY / LUMA_EVENT_ID missing) — skipping guest add for', session.id);
    return;
  }

  const email = session.customer_details && session.customer_details.email;
  if (!email) {
    console.error('Stripe session has no customer email — cannot add Luma guest for', session.id);
    return;
  }

  // Guests keep landing in the wrong Luma event despite this reading
  // process.env.LUMA_EVENT_ID fresh every call with no caching or fallback —
  // logging the raw value (JSON-stringified so stray whitespace/newlines
  // from a copy-paste into the Netlify UI are visible) to confirm whether
  // the deployed value actually matches what's intended.
  console.log(`LUMA_EVENT_ID as read by this invocation: ${JSON.stringify(process.env.LUMA_EVENT_ID)}`);

  try {
    const eventId = process.env.LUMA_EVENT_ID;
    const qty = Number(session.metadata.qty);
    const result = await addTicketsForBuyer(eventId, {
      email,
      name: session.customer_details.name,
      qty
    });
    const breakdown = result.typesUsed.map((t) => `${t.count}x ${t.name}`).join(', ');
    console.log(
      `Added ${qty} ticket(s) for ${email} to Luma event ${eventId} (${breakdown}) for session ${session.id} — ` +
        `${result.wasExistingGuest ? 'existing guest topped up' : 'new guest'}, ` +
        `${result.ticketsBefore} → ${result.ticketsAfter} ticket(s) total.`
    );
  } catch (err) {
    console.error(`Failed to add Luma guest for session ${session.id}:`, err.message);
  }
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: 'invalid signature' };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    let productIds;
    try {
      productIds = await getSessionProductIds(session);
    } catch (err) {
      console.error(`Failed to look up line items for session ${session.id}:`, err.message);
      return { statusCode: 200, body: 'ok' };
    }

    const isTicket = productIds.some((id) => TICKET_PRODUCT_IDS.includes(id));
    if (!isTicket) {
      console.log(`Ignoring session ${session.id} — product(s) [${productIds.join(', ')}] aren't this event's ticket.`);
      return { statusCode: 200, body: 'ok' };
    }

    const proto = event.headers['x-forwarded-proto'] || 'https';
    const siteUrl = proto + '://' + event.headers.host;
    await Promise.all([sendMetaPurchase(session, siteUrl), sendPostHogPurchase(session), addLumaGuest(session)]);
  }

  return { statusCode: 200, body: 'ok' };
};
