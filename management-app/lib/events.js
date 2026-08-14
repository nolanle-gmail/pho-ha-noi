// A tiny in-process event bus for live push. Visit mutations emit here; the SSE
// endpoint (routes/visits.js) fans out to subscribed clients so seatings, claims,
// and status changes reach every open board within a moment. Single-machine —
// fine for one Fly VM per app; a multi-instance deploy would need a shared pub/sub.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open SSE connection

module.exports = {
  emitVisits: (locationId) => {
    const id = locationId != null ? Number(locationId) : null;
    bus.emit('visits', { location_id: Number.isFinite(id) ? id : null });
  },
  onVisits: (handler) => { bus.on('visits', handler); return () => bus.off('visits', handler); },
};
