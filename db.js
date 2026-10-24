const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ege.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_super      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    task_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_topics (
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    task_number INTEGER NOT NULL,
    topic       TEXT NOT NULL,
    PRIMARY KEY (subject_id, task_number)
  );

  -- Предметы, которые может редактировать обычный (не главный) администратор
  CREATE TABLE IF NOT EXISTS admin_subjects (
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (admin_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS classes (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS class_subjects (
    class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (class_id, subject_id)
  );

  -- Отсутствие строки = задача не начата
  CREATE TABLE IF NOT EXISTS progress (
    class_id    INTEGER NOT NULL,
    subject_id  INTEGER NOT NULL,
    task_number INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('done', 'in_progress')),
    date        TEXT NOT NULL,
    updated_by  TEXT,
    PRIMARY KEY (class_id, subject_id, task_number),
    FOREIGN KEY (class_id, subject_id)
      REFERENCES class_subjects(class_id, subject_id) ON DELETE CASCADE
  );
`);

// ---------- пароли ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- транзакции ----------

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- первый админ ----------

function ensureFirstAdmin() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM admins').get();
  if (n > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO admins (username, password_hash, is_super) VALUES (?, ?, 1)')
    .run(username, hashPassword(password));

  console.log('\n==============================================');
  console.log(' Создан главный администратор');
  console.log(`   логин:  ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`   пароль: ${password}`);
  console.log(' Смените пароль после первого входа.');
  console.log('==============================================\n');
}

module.exports = { db, hashPassword, verifyPassword, transaction, ensureFirstAdmin };
