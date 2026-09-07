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

// Luma's guest-list entries have historically come back both flat and
// wrapped in a `guest` object. Read through either shape so a change on
// their side can't silently turn every guest into "no tickets, no email"
// — which would both mis-count capacity and hide existing buyers.
function normalizeGuest(entry) {
  if (!entry) return null;
  const guest = entry.guest && typeof entry.guest === 'object' ? entry.guest : entry;
  return {
    apiId: guest.api_id || entry.api_id || null,
    email: typeof guest.email === 'string' ? guest.email : null,
    name: guest.name || null,
    approvalStatus: guest.approval_status || null,
    tickets: Array.isArray(guest.event_tickets) ? guest.event_tickets : [],
    raw: guest
  };
}

function sameEmail(a, b) {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
  return all.map(normalizeGuest).filter(Boolean);
}

// Cheapest-first tiers with how many seats are actually left in each,
// counting only tickets held by non-declined guests. A tier with
// max_capacity: null never fills, so it acts as the automatic overflow
// once everything else is sold.
function tiersWithRemaining(ticketTypes, guests) {
  const soldByType = {};
  for (const guest of guests) {
    if (guest.approvalStatus === 'declined') continue;
    for (const ticket of guest.tickets) {
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

// One read of everything an add needs: the tier capacities and the full
// guest list. Fetched together so the "is this buyer already a guest?"
// check costs nothing extra beyond what capacity counting already reads.
async function getEventSnapshot(eventId) {
  const [{ entries: ticketTypes }, guests] = await Promise.all([
    lumaGet('/v1/events/ticket-types/list', { event_id: eventId }),
    listAllGuests(eventId)
  ]);
  return { guests, tiers: tiersWithRemaining(ticketTypes, guests) };
}

async function getTicketTypesWithRemaining(eventId) {
  const { tiers } = await getEventSnapshot(eventId);
  return tiers;
}

// A buyer who already has tickets is matched on email. Prefer a
// non-declined record: a declined guest is one the host removed, so a
// fresh paid order should not quietly top up that record.
function findGuestByEmail(guests, email) {
  const matches = guests.filter((g) => sameEmail(g.email, email));
  return matches.find((g) => g.approvalStatus !== 'declined') || matches[0] || null;
}

function countTicketsFor(guests, email) {
  return guests
    .filter((g) => sameEmail(g.email, email) && g.approvalStatus !== 'declined')
    .reduce((sum, g) => sum + g.tickets.length, 0);
}

// Spreads `qty` tickets over the cheapest tiers that still have room,
// spilling into the next one(s) when qty is bigger than what's left —
// a bundle purchase can otherwise land right on a capacity boundary and
// oversell a tier by assigning every ticket to it.
function allocateTickets(tiers, qty) {
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
      `Not enough Luma ticket capacity left (needed ${qty}, only ${qty - left} available)`
    );
  }

  return { tickets, typesUsed };
}

// Adds `qty` tickets for one buyer and returns what actually landed.
//
// The important case: a buyer who ALREADY has tickets. Luma's
// guests/add silently skips an email that's already on the guest list —
// tickets and all — so a repeat purchase (4 tickets now, 1 more later)
// used to be accepted by Stripe/HitPay and then dropped on the floor.
// Existing guests therefore go through guests/update-tickets, which
// appends to the tickets they already hold. Tiers are still allocated
// cheapest-first, so a top-up can sit in a different tier than the
// original order and both are kept.
//
// Every add is verified by re-reading the guest list afterwards: the
// caller only sees success if the buyer's ticket count really went up
// by `qty`.
async function addTicketsForBuyer(eventId, { email, name, qty }) {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error(`Invalid ticket quantity: ${qty}`);
  }

  const { guests, tiers } = await getEventSnapshot(eventId);
  const existing = findGuestByEmail(guests, email);
  const ticketsBefore = countTicketsFor(guests, email);
  const { tickets, typesUsed } = allocateTickets(tiers, qty);

  let postError = null;
  try {
    if (existing) {
      if (!existing.apiId) {
        throw new Error(`Luma guest ${email} has no api_id — cannot add ${qty} more ticket(s)`);
      }
      await lumaPost('/v1/events/guests/update-tickets', {
        event_id: eventId,
        guest_api_id: existing.apiId,
        add_tickets: tickets
      });
    } else {
      await lumaPost('/v1/events/guests/add', {
        event_id: eventId,
        guests: [{ email, name: name || null }],
        tickets
      });
    }
  } catch (err) {
    postError = err;
  }

  // Always re-read, including after a failed call: a request that timed
  // out or errored on the way back can still have landed, and a caller
  // retrying needs to know how many tickets are really there before
  // topping up — otherwise the retry hands out duplicates.
  const ticketsAfter = countTicketsFor(await listAllGuests(eventId), email);
  const added = Math.max(0, ticketsAfter - ticketsBefore);

  if (postError || added < qty) {
    const reason = postError
      ? postError.message
      : `expected ${ticketsBefore + qty} ticket(s) after adding ${qty}, found ${ticketsAfter}`;
    const err = new Error(`Luma did not register all tickets for ${email}: ${reason}`);
    err.ticketsBefore = ticketsBefore;
    err.ticketsAfter = ticketsAfter;
    err.added = added;
    throw err;
  }

  return {
    wasExistingGuest: Boolean(existing),
    ticketsBefore,
    ticketsAfter,
    added,
    typesUsed: typesUsed.map((t) => ({ id: t.type.id, name: t.type.name, count: t.count }))
  };
}

// Back-compat wrapper for the original single-shot add.
async function addGuestWithNextAvailableTicket(eventId, { email, name, qty }) {
  const result = await addTicketsForBuyer(eventId, { email, name, qty });
  return result.typesUsed;
}

module.exports = {
  getTicketTypesWithRemaining,
  addTicketsForBuyer,
  addGuestWithNextAvailableTicket
};
