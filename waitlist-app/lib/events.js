// In-process event bus for the Staff app's live push. Waitlist changes (a party
// added — including a kiosk self-check-in — notified, seated, or removed) emit
// here; the SSE endpoint (routes/stream.js) fans them out, and also forwards the
// Management visit stream, so Front-Desk / Server boards update within a moment.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

module.exports = {
  emitWaitlist: (locationId) => {
    const id = locationId != null ? Number(locationId) : null;
    bus.emit('waitlist', { location_id: Number.isFinite(id) ? id : null });
  },
  onWaitlist: (handler) => { bus.on('waitlist', handler); return () => bus.off('waitlist', handler); },
};
