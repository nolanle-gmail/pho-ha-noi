// Emoji reactions (iMessage-style tapbacks) shared by direct messages and chat.
// One row per (kind, target, user, emoji); toggling the same emoji removes it.
const db = require('../db/database');

// The reaction set offered in the picker (Haha & Heart included).
// Reaction tokens. Mostly emoji, plus the iMessage-style word tapback "Haha".
const REACTIONS = ['❤️', 'Haha', '👍', '🙏', '😮', '😢', '👎'];

// Add or remove the acting user's reaction. Returns true if now reacted, false if removed.
function toggleReaction(kind, targetId, userId, emoji) {
  if (!REACTIONS.includes(emoji)) throw new Error('Unsupported reaction.');
  const had = db.prepare(`SELECT 1 FROM msg_reactions WHERE kind=? AND target_id=? AND user_id=? AND emoji=?`).get(kind, targetId, userId, emoji);
  if (had) { db.prepare(`DELETE FROM msg_reactions WHERE kind=? AND target_id=? AND user_id=? AND emoji=?`).run(kind, targetId, userId, emoji); return false; }
  db.prepare(`INSERT OR IGNORE INTO msg_reactions (kind, target_id, user_id, emoji) VALUES (?,?,?,?)`).run(kind, targetId, userId, emoji);
  return true;
}

// Attach a `reactions` array to each row: [{ emoji, count, users:[names], mine }].
// Sorted by first-reacted so the display order is stable. One query for the whole page.
function attachReactions(kind, rows, meId) {
  if (!rows || !rows.length) return rows;
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const rx = db.prepare(`SELECT r.target_id, r.emoji, r.user_id, r.created_at, u.name
    FROM msg_reactions r JOIN users u ON u.id=r.user_id
    WHERE r.kind=? AND r.target_id IN (${ph}) ORDER BY r.created_at, r.rowid`).all(kind, ...ids);
  const byTarget = new Map();
  for (const r of rx) {
    let m = byTarget.get(r.target_id); if (!m) { m = new Map(); byTarget.set(r.target_id, m); }
    let e = m.get(r.emoji); if (!e) { e = { emoji: r.emoji, count: 0, users: [], mine: false }; m.set(r.emoji, e); }
    e.count++; e.users.push(r.name); if (Number(r.user_id) === Number(meId)) e.mine = true;
  }
  for (const row of rows) { const m = byTarget.get(row.id); row.reactions = m ? [...m.values()] : []; }
  return rows;
}

// Flag a reaction as unseen for each person in the conversation (drives their badge).
function markReactionUnseen(kind, convId, userIds) {
  if (!convId) return;
  const ins = db.prepare(`INSERT OR IGNORE INTO reaction_unseen (user_id, kind, conv_id) VALUES (?,?,?)`);
  for (const uid of userIds) { try { ins.run(uid, kind, convId); } catch { /* ignore */ } }
}
// Clear a person's unseen-reaction flag for a conversation (they opened it).
function clearReactionUnseen(kind, convId, userId) {
  try { db.prepare(`DELETE FROM reaction_unseen WHERE user_id=? AND kind=? AND conv_id=?`).run(userId, kind, convId); } catch { /* ignore */ }
}
// How many conversations of a kind have an unseen reaction for me (for the badge).
function unseenReactionCount(kind, userId) {
  return db.prepare(`SELECT COUNT(*) c FROM reaction_unseen WHERE user_id=? AND kind=?`).get(userId, kind).c;
}

module.exports = { REACTIONS, toggleReaction, attachReactions, markReactionUnseen, clearReactionUnseen, unseenReactionCount };
