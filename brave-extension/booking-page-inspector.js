// Booking.com read-only page inspector. Run only on a Booking.com hotel page
// using chrome.scripting.executeScript with explicit user action.
// Does not click buttons, change dates, fill personal data, or place reservations.
(() => {
  if (location.hostname !== 'www.booking.com' && location.hostname !== 'booking.com') {
    return { ok: false, error: 'Not a Booking.com page' };
  }
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
  const url = new URL(location.href);
  const params = url.searchParams;
  const title = text('h2[data-testid="title"]') || text('h1') || document.title;
  const prices = [...document.querySelectorAll('[data-testid="price-and-discounted-price"], .bui-price-display__value')]
    .map(el => el.textContent.trim()).filter(Boolean).slice(0, 12);
  const rooms = [...document.querySelectorAll('[data-testid="room-name"], .hprt-roomtype-icon-link')]
    .map(el => el.textContent.trim()).filter(Boolean).slice(0, 12);
  const unavailable = /no availability|sold out|not available for your dates/i.test(document.body.innerText.slice(0, 30000));
  return {
    ok: true,
    inspectedAt: new Date().toISOString(),
    property: title,
    listingUrl: location.origin + location.pathname,
    checkin: params.get('checkin') || params.get('checkin_year_month_monthday') || null,
    checkout: params.get('checkout') || null,
    adults: params.get('group_adults') || null,
    roomsRequested: params.get('no_rooms') || null,
    visiblePrices: prices,
    visibleRoomTypes: rooms,
    possibleUnavailableMessage: unavailable,
    note: 'Read-only snapshot, not verified inventory or a reservation.'
  };
})()
