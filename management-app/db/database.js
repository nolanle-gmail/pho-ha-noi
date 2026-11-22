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
// Read-performance tuning. The production DB is multi-GB (the Toast POS mirror alone is
// ~1M+ rows) but node:sqlite is SYNCHRONOUS and single-threaded — any query that misses
// the page cache does blocking disk I/O that freezes the whole event loop for every
// staff request. The 2 MB default cache is far too small for this file, so bump it and
// memory-map the DB so hot pages stay resident. Values are conservative for a 512 MB VM
// (cache_size is heap; mmap is file-backed and reclaimable by the OS under pressure).
try { db.exec('PRAGMA synchronous = NORMAL'); } catch { /* safe with WAL; fewer fsyncs */ }
try { db.exec('PRAGMA cache_size = -32768'); } catch { /* 32 MB page cache (was ~2 MB) */ }
try { db.exec('PRAGMA mmap_size = 268435456'); } catch { /* 256 MB memory-map for fast reads */ }
try { db.exec('PRAGMA temp_store = MEMORY'); } catch { /* keep sorts/temp b-trees off disk */ }

module.exports = db;
