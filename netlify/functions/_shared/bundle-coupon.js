// Coupons are matched by their Name field, not their Coupon ID — Stripe's
// dashboard auto-generates a random ID unless you explicitly override it,
// so the human-chosen "THB-OFF" label only reliably lives in `name`.
// Naming scheme: buying `qty` tickets (qty >= 2) knocks (qty - 1) * 100 THB
// off the order, e.g. 2 tickets -> "100THB-OFF", 5 tickets -> "400THB-OFF".
// There's no coupon beyond that, so anything above the 5-ticket cap just
// gets the same 400.
function bundleCouponName(qty) {
  return (Math.min(qty, 5) - 1) * 100 + 'THB-OFF';
}

async function findBundleCoupon(stripe, qty) {
  const coupons = await stripe.coupons.list({ limit: 100 });
  return coupons.data.find((c) => c.name === bundleCouponName(qty) && c.valid) || null;
}

module.exports = { findBundleCoupon, bundleCouponName };
