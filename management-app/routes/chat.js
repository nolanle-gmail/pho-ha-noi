// Staff chat groups — persistent, membership-scoped group conversations (like
// channels), shown on the Messages page. Everyone can create a group from the
// staff list; only members see and post; leadership (owner/admin/general_manager)
// can audit any group; owner/admin can deactivate one (messages are retained for
// audit). Reached by the Staff app over the service key + ?as=<email>, like messages.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { verifyToken, SECRET } = require('../lib/auth');
const { emitChat } = require('../lib/events');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const MAX_BODY = 4000;
const AUDIT = ['owner', 'admin', 'general_manager']; // may read/list any group
const CAN_DELETE = ['owner', 'admin'];                // may deactivate a group

// Auth: a Management JWT, OR the Staff-app service key with ?as=<email>.
router.use((req, res, next) => {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || req.headers['x-as-user'] || '').toLowerCase().trim();
    const u = email && db.prepare(`SELECT id, name, role, location_id FROM users WHERE lower(email)=? AND is_active=1`).get(email);
    if (!u) return res.status(401).json({ error: 'Unknown chat user.' });
    req.user = { id: u.id, name: u.name, role: u.role, location_id: u.location_id };
    return next();
  }
  return verifyToken(req, res, next);
});

const isMember = (groupId, userId) => !!db.prepare(`SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?`).get(groupId, userId);
const isAudit = (role) => AUDIT.includes(role);
const markRead = (groupId, userId, lastId) => db.prepare(
  `INSERT INTO chat_reads (group_id, user_id, last_read_id) VALUES (?,?,?)
   ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_id=MAX(last_read_id, excluded.last_read_id)`
).run(groupId, userId, lastId);

// My chat groups (member of), newest-activity first, with unread counts.
// Leadership may pass ?scope=all to list every active group for audit.
router.get('/groups', (req, res) => {
  const uid = req.user.id;
  const all = req.query.scope === 'all' && isAudit(req.user.role);
  const params = [uid]; // the unread subquery
  let where = 'g.is_active=1';
  if (!all) { where += ' AND g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)'; params.push(uid); }
  const rows = db.prepare(`
    SELECT g.id, g.name, g.created_at, g.created_by,
      (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id) AS member_count,
      (SELECT body FROM chat_messages cm WHERE cm.group_id=g.id ORDER BY cm.id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM chat_messages cm WHERE cm.group_id=g.id ORDER BY cm.id DESC LIMIT 1) AS last_at,
      (SELECT MAX(cm.id) FROM chat_messages cm WHERE cm.group_id=g.id) AS last_id,
      (SELECT COUNT(*) FROM chat_messages cm WHERE cm.group_id=g.id
         AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=g.id AND r.user_id=?),0)) AS unread
    FROM chat_groups g
    WHERE ${where}
    ORDER BY last_id DESC, g.id DESC
  `).all(...params);
  res.json(rows.map(r => ({ ...r, is_member: all ? isMember(r.id, uid) : true, audit: all })));
});

// Total unread chat messages across my groups (for a nav badge).
router.get('/unread-count', (req, res) => {
  const n = db.prepare(`
    SELECT COALESCE(SUM(u),0) AS c FROM (
      SELECT (SELECT COUNT(*) FROM chat_messages cm WHERE cm.group_id=g.id
                AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=g.id AND r.user_id=?),0)) AS u
      FROM chat_groups g
      WHERE g.is_active=1 AND g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)
    )`).get(req.user.id, req.user.id).c;
  res.json({ count: n });
});

// Create a group from a set of staff. The creator is always a member.
router.post('/groups', (req, res) => {
  const name = String(req.body && req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Group name is required.' });
  const ids = Array.isArray(req.body.member_ids) ? req.body.member_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  const valid = ids.length
    ? db.prepare(`SELECT id FROM users WHERE is_active=1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.id)
    : [];
  const members = [...new Set([req.user.id, ...valid])]; // creator joins automatically
  if (members.length < 2) return res.status(400).json({ error: 'Pick at least one other member.' });
  db.exec('BEGIN');
  try {
    const gid = Number(db.prepare(`INSERT INTO chat_groups (name, created_by) VALUES (?,?)`).run(name, req.user.id).lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?,?)`);
    members.forEach(m => ins.run(gid, m));
    db.exec('COMMIT');
    res.json({ success: true, id: gid, name, member_count: members.length });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// Group detail (name + members). Members, or leadership for audit.
router.get('/groups/:id', (req, res) => {
  const g = db.prepare(`SELECT * FROM chat_groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const member = isMember(g.id, req.user.id);
  if (!member && !isAudit(req.user.role)) return res.status(403).json({ error: 'Not a member of this group.' });
  const members = db.prepare(`SELECT u.id, u.name, u.role FROM chat_group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.name`).all(g.id);
  res.json({ id: g.id, name: g.name, is_active: !!g.is_active, created_by: g.created_by, member, is_audit: !member && isAudit(req.user.role), can_delete: CAN_DELETE.includes(req.user.role), members });
});

// A group's messages (oldest first). Members, or leadership for audit. Opening as a
// member marks the group read.
router.get('/groups/:id/messages', (req, res) => {
  const g = db.prepare(`SELECT * FROM chat_groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const member = isMember(g.id, req.user.id);
  if (!member && !isAudit(req.user.role)) return res.status(403).json({ error: 'Not a member of this group.' });
  const messages = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.sender_id, u.name AS sender_name, u.role AS sender_role
    FROM chat_messages c JOIN users u ON u.id=c.sender_id
    WHERE c.group_id=? ORDER BY c.id ASC LIMIT 500`).all(g.id);
  if (member && messages.length) markRead(g.id, req.user.id, messages[messages.length - 1].id);
  res.json({ id: g.id, name: g.name, is_active: !!g.is_active, me: req.user.id, member, is_audit: !member && isAudit(req.user.role), can_delete: CAN_DELETE.includes(req.user.role), messages });
});

// Post a message to a group. Members only (leadership audit is read-only).
router.post('/groups/:id/messages', (req, res) => {
  const g = db.prepare(`SELECT * FROM chat_groups WHERE id=? AND is_active=1`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  if (!isMember(g.id, req.user.id)) return res.status(403).json({ error: 'Only members can post to this group.' });
  const body = String(req.body && req.body.body || '').trim().slice(0, MAX_BODY);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const mid = Number(db.prepare(`INSERT INTO chat_messages (group_id, sender_id, body) VALUES (?,?,?)`).run(g.id, req.user.id, body).lastInsertRowid);
  markRead(g.id, req.user.id, mid);
  const memberIds = db.prepare(`SELECT user_id FROM chat_group_members WHERE group_id=?`).all(g.id).map(r => r.user_id);
  try { emitChat({ group_id: g.id, member_ids: memberIds, sender_id: req.user.id }); } catch { /* live push best-effort */ }
  res.json({ success: true, id: mid });
});

// Deactivate a group (owner/admin). Messages are retained for audit.
router.delete('/groups/:id', (req, res) => {
  if (!CAN_DELETE.includes(req.user.role)) return res.status(403).json({ error: 'Only an owner or admin can delete a chat group.' });
  const g = db.prepare(`SELECT id FROM chat_groups WHERE id=?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  db.prepare(`UPDATE chat_groups SET is_active=0 WHERE id=?`).run(g.id);
  res.json({ success: true, id: Number(g.id) });
});

module.exports = router;
