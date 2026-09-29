// SQLite bootstrap using Node's built-in driver (node:sqlite, Node 22+).
// No external database dependency — same approach as the source design.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'phohanoi_management.db');

// Open the DB in WAL mode. We deliberately do NOT try to "self-heal" by deleting
// the -wal/-shm sidecars on failure: dropping -wal can turn a recoverable
// disk-full/dirty-shutdown state into real corruption. If open fails, we fail
// loudly and let ops recover from a volume snapshot instead.
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

module.exports = db;
