// Ежедневные резервные копии базы: data/backups/ege-ГГГГ-ММ-ДД.db, хранятся последние 30.
// Папку можно поменять через BACKUP_DIR — например, на папку Google Диска,
// тогда копии будут сами загружаться в облако.
//
//   npm run backup   — сделать копию прямо сейчас

const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 30;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FILE_RE = /^ege-\d{4}-\d{2}-\d{2}\.db$/;

function localDate() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function backupFile(date = localDate()) {
  return path.join(BACKUP_DIR, `ege-${date}.db`);
}

function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = backupFile();
  // Пишем во временный файл и потом переименовываем, чтобы синхронизация с облаком
  // не успела забрать недописанную копию
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  // VACUUM INTO собирает целую и сжатую копию, даже пока на сайте ставят отметки
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  fs.renameSync(tmp, file);
  pruneOld();
  return file;
}

function pruneOld() {
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => FILE_RE.test(f)).sort().reverse().slice(BACKUP_KEEP);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
}

// Раз в час проверяем, есть ли копия за сегодня. Так копия появится, даже если
// сервер перезапускали или компьютер спал ночью.
function startBackups() {
  const tick = () => {
    if (fs.existsSync(backupFile())) return;
    try {
      console.log(`Резервная копия сохранена: ${backupNow()}`);
    } catch (err) {
      console.error(`Не удалось сделать резервную копию в ${BACKUP_DIR}: ${err.message}`);
    }
  };
  tick();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

if (require.main === module) {
  console.log(`Резервная копия сохранена: ${backupNow()}`);
}

module.exports = { startBackups, backupNow, BACKUP_DIR };
