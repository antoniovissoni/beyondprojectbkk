const LUMA_BASE_URL = 'https://public-api.luma.com';

async function lumaGet(path, params = {}) {
  const url = new URL(LUMA_BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: { 'x-luma-api-key': process.env.LUMA_API_KEY, accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Luma API ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function lumaPost(path, body) {
  const res = await fetch(LUMA_BASE_URL + path, {
    method: 'POST',
    headers: {
      'x-luma-api-key': process.env.LUMA_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Luma API ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function listAllGuests(eventId) {
  let cursor;
  const all = [];
  do {
    const page = await lumaGet('/v1/events/guests/list', {
      event_id: eventId,
      pagination_cursor: cursor,
      pagination_limit: 100
    });
    all.push(...(page.entries ?? []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return all;
}

// Cheapest-first tiers with how many seats are actually left in each,
// counting only tickets held by non-declined guests. A tier with
// max_capacity: null never fills, so it acts as the automatic overflow
// once everything else is sold.
async function getTicketTypesWithRemaining(eventId) {
  const [{ entries: ticketTypes }, guests] = await Promise.all([
    lumaGet('/v1/events/ticket-types/list', { event_id: eventId }),
    listAllGuests(eventId)
  ]);

  const soldByType = {};
  for (const guest of guests) {
    if (guest.approval_status === 'declined') continue;
    for (const ticket of guest.event_tickets ?? []) {
      soldByType[ticket.event_ticket_type_id] = (soldByType[ticket.event_ticket_type_id] ?? 0) + 1;
    }
  }

  return [...ticketTypes]
    .filter((t) => !t.is_hidden)
    .sort((a, b) => (a.cents ?? 0) - (b.cents ?? 0))
    .map((type) => {
      const sold = soldByType[type.id] ?? 0;
      const remaining = type.max_capacity == null ? Infinity : Math.max(0, type.max_capacity - sold);
      return { type, remaining };
    });
}

// Adds `qty` tickets to one guest in a single Luma API call, filling the
// cheapest tier first and spilling into the next one(s) if `qty` is bigger
// than what's left in the current tier — a bundle purchase can otherwise
// land right on a capacity boundary and oversell a tier by assigning every
// ticket to it regardless of how many seats actually remain there.
// Returns the distinct ticket types actually used, cheapest-first.
async function addGuestWithNextAvailableTicket(eventId, { email, name, qty }) {
  const tiers = await getTicketTypesWithRemaining(eventId);

  const tickets = [];
  const typesUsed = [];
  let left = qty;
  for (const { type, remaining } of tiers) {
    if (left <= 0) break;
    if (remaining <= 0) continue;
    const take = Math.min(remaining, left);
    for (let i = 0; i < take; i++) tickets.push({ event_ticket_type_id: type.id });
    typesUsed.push({ type, count: take });
    left -= take;
  }

  if (left > 0) {
    throw new Error(
      `Not enough Luma ticket capacity left for event ${eventId} (needed ${qty}, only ${qty - left} available)`
    );
  }

  await lumaPost('/v1/events/guests/add', {
    event_id: eventId,
    guests: [{ email, name: name || null }],
    tickets
  });

  return typesUsed.map((t) => t.type);
}

module.exports = { getTicketTypesWithRemaining, addGuestWithNextAvailableTicket };
