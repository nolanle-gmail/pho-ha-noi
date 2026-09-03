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
  // A new message delivered to these recipient user ids — for live inbox/badge.
  emitMessages: (userIds) => { bus.emit('messages', { user_ids: (userIds || []).map(Number).filter(Boolean) }); },
  onMessages: (handler) => { bus.on('messages', handler); return () => bus.off('messages', handler); },
  // A floor alert was raised (the SSE stream decides who it matches) …
  emitAlert: (alert) => { bus.emit('alert', alert); },
  onAlert: (handler) => { bus.on('alert', handler); return () => bus.off('alert', handler); },
  // … and acknowledged (pushed back to the sender so they see who's on it).
  emitAlertAck: (ack) => { bus.emit('alert_ack', ack); },
  onAlertAck: (handler) => { bus.on('alert_ack', handler); return () => bus.off('alert_ack', handler); },
  // A new chat-group message — delivered live to the group's members.
  emitChat: (payload) => { bus.emit('chat', payload); },
  onChat: (handler) => { bus.on('chat', handler); return () => bus.off('chat', handler); },
};
