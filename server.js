const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(`Нужен Node.js 22.13 или новее, а установлен ${process.version}. Обновите Node.js: https://nodejs.org`);
  process.exit(1);
}

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, hashPassword, verifyPassword, transaction, ensureFirstAdmin } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 30;
const MAX_TASKS = 100;

ensureFirstAdmin();

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '200kb' }));
// Express считает /admin и /admin/ одним путём, поэтому сравниваем сами
app.use((req, res, next) => (req.path === '/admin/' ? res.redirect(301, '../admin') : next()));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- утилиты ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Битую куку (например, «%E0») пропускаем, а не падаем с ошибкой 500
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* пропускаем */ }
  }
  return out;
}

function str(value, field, { min = 1, max = 100 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `Поле «${field}» должно быть строкой`);
  const v = value.trim();
  if (v.length < min || v.length > max) {
    throw new HttpError(400, `Поле «${field}»: от ${min} до ${max} символов`);
  }
  return v;
}

function int(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `Поле «${field}» должно быть целым числом от ${min} до ${max}`);
  }
  return n;
}

function today(offsetDays = 0) {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function date(value) {
  // Проверяем, что такая дата существует (31 февраля — нет). Завтрашнюю дату разрешаем
  // на случай, если у учителя на компьютере другой часовой пояс.
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`);
  const ok = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  if (!ok) throw new HttpError(400, 'Неверная дата');
  if (value > today(1)) throw new HttpError(400, 'Дата не может быть в будущем');
  return value;
}

// SQLite сравнивает без учёта регистра только латиницу, поэтому «11А» и «11а» проверяем сами
function assertUniqueName(table, column, name, exceptId = null) {
  const lower = name.toLocaleLowerCase('ru');
  const taken = db.prepare(`SELECT id, ${column} AS name FROM ${table}`).all()
    .some((r) => r.id !== exceptId && r.name.toLocaleLowerCase('ru') === lower);
  if (taken) throw new HttpError(409, `«${name}» уже есть`);
}

function idList(value, field) {
  if (!Array.isArray(value)) throw new HttpError(400, `Поле «${field}» должно быть списком`);
  return [...new Set(value.map((v) => int(v, field)))];
}

// ---------- сессии ----------

function currentAdmin(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = db.prepare(`
    SELECT a.id, a.username, a.is_super
    FROM sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now());
  if (!row) return null;
  return { id: row.id, username: row.username, is_super: !!row.is_super, subject_ids: adminSubjectIds(row.id) };
}

function adminSubjectIds(adminId) {
  return db.prepare('SELECT subject_id FROM admin_subjects WHERE admin_id = ? ORDER BY subject_id').all(adminId)
    .map((r) => r.subject_id);
}

function canEditSubject(admin, subjectId) {
  return admin.is_super || admin.subject_ids.includes(subjectId);
}

function setAdminSubjects(adminId, subjectIds) {
  const exists = db.prepare('SELECT 1 FROM subjects WHERE id = ?');
  for (const sid of subjectIds) {
    if (!exists.get(sid)) throw new HttpError(400, 'Указан несуществующий предмет');
  }
  db.prepare('DELETE FROM admin_subjects WHERE admin_id = ?').run(adminId);
  const add = db.prepare('INSERT INTO admin_subjects (admin_id, subject_id) VALUES (?, ?)');
  for (const sid of subjectIds) add.run(adminId, sid);
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`);
}

function requireAdmin(req, res, next) {
  req.admin = currentAdmin(req);
  if (!req.admin) throw new HttpError(401, 'Нужно войти в аккаунт');
  next();
}

function requireSuper(req, res, next) {
  if (!req.admin.is_super) throw new HttpError(403, 'Только для главного администратора');
  next();
}

// Защита от перебора паролей: 10 неудачных попыток за 15 минут для пары «логин + IP».
// Считаем не по одному IP, потому что в школе все компьютеры часто выходят в сеть
// через общий адрес — иначе любой ученик мог бы заблокировать вход всем учителям.
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function loginKey(username, ip) {
  return `${username.toLowerCase()}|${ip}`;
}

function checkLoginLimit(key) {
  const entry = loginFailures.get(key);
  if (entry && entry.until > Date.now() && entry.count >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, 'Слишком много попыток. Попробуйте через 15 минут');
  }
}

function recordLoginFailure(key) {
  const entry = loginFailures.get(key);
  if (!entry || entry.until < Date.now()) {
    loginFailures.set(key, { count: 1, until: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
}

// Чистим устаревшие записи, чтобы перебор разных логинов не раздувал память
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) if (entry.until < now) loginFailures.delete(key);
}, LOGIN_WINDOW_MS).unref();

// ---------- авторизация ----------

app.post('/api/login', (req, res) => {
  const username = str(req.body?.username, 'Логин');
  const password = str(req.body?.password, 'Пароль', { max: 200 });
  const key = loginKey(username, req.ip);
  checkLoginLimit(key);

  const lower = username.toLocaleLowerCase('ru');
  const admin = db.prepare('SELECT * FROM admins').all()
    .find((a) => a.username.toLocaleLowerCase('ru') === lower);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    recordLoginFailure(key);
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  loginFailures.delete(key);

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)')
    .run(token, admin.id, Date.now() + SESSION_DAYS * 86400000);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json({ id: admin.id, username: admin.username, is_super: !!admin.is_super,
    subject_ids: adminSubjectIds(admin.id) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json(currentAdmin(req));
});

app.put('/api/me/password', requireAdmin, (req, res) => {
  const current = str(req.body?.current, 'Текущий пароль', { max: 200 });
  const next = str(req.body?.password, 'Новый пароль', { min: 6, max: 200 });
  const { password_hash } = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(req.admin.id);
  if (!verifyPassword(current, password_hash)) throw new HttpError(400, 'Текущий пароль неверный');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.admin.id);
  // Выкидываем из сессий на других устройствах — на случай, если старый пароль кто-то узнал
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token != ?')
    .run(req.admin.id, parseCookies(req.headers.cookie).sid);
  res.json({ ok: true });
});

// ---------- общие данные (видны всем) ----------

app.get('/api/data', (req, res) => {
  const admin = currentAdmin(req);

  const subjects = db.prepare('SELECT id, name, task_count FROM subjects').all()
    .map((s) => ({ ...s, topics: {} }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const byId = new Map(subjects.map((s) => [s.id, s]));
  for (const t of db.prepare('SELECT * FROM task_topics').all()) {
    const s = byId.get(t.subject_id);
    if (s && t.task_number <= s.task_count) s.topics[t.task_number] = t.topic;
  }

  const classes = db.prepare('SELECT id, name FROM classes').all()
    .map((c) => ({ ...c, subject_ids: [] }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  const classById = new Map(classes.map((c) => [c.id, c]));
  for (const cs of db.prepare('SELECT * FROM class_subjects').all()) {
    classById.get(cs.class_id)?.subject_ids.push(cs.subject_id);
  }

  const progress = db.prepare(`
    SELECT p.class_id, p.subject_id, p.task_number, p.status, p.date, p.updated_by
    FROM progress p JOIN subjects s ON s.id = p.subject_id
    WHERE p.task_number <= s.task_count
  `).all().map((p) => {
    const row = { ...p };
    if (!admin) delete row.updated_by;
    return row;
  });

  res.json({ subjects, classes, progress, admin });
});

// ---------- предметы ----------

function saveTopics(subjectId, taskCount, topics) {
  if (topics === undefined) return;
  if (typeof topics !== 'object' || topics === null) throw new HttpError(400, 'Темы заданы неверно');
  db.prepare('DELETE FROM task_topics WHERE subject_id = ?').run(subjectId);
  const insert = db.prepare('INSERT INTO task_topics (subject_id, task_number, topic) VALUES (?, ?, ?)');
  for (const [num, topic] of Object.entries(topics)) {
    const n = int(num, 'Номер задачи', { max: taskCount });
    if (typeof topic !== 'string' || !topic.trim()) continue;
    insert.run(subjectId, n, topic.trim().slice(0, 200));
  }
}

app.post('/api/subjects', requireAdmin, requireSuper, (req, res) => {
  const name = str(req.body?.name, 'Название');
  const taskCount = int(req.body?.task_count, 'Количество задач', { max: MAX_TASKS });
  assertUniqueName('subjects', 'name', name);
  const id = transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO subjects (name, task_count) VALUES (?, ?)')
      .run(name, taskCount);
    saveTopics(lastInsertRowid, taskCount, req.body?.topics);
    return Number(lastInsertRowid);
  });
  res.status(201).json({ id });
});

app.put('/api/subjects/:id', requireAdmin, (req, res) => {
  const id = int(req.params.id, 'id');
  if (!canEditSubject(req.admin, id)) throw new HttpError(403, 'У вас нет прав на этот предмет');
  const name = str(req.body?.name, 'Название');
  const taskCount = int(req.body?.task_count, 'Количество задач', { max: MAX_TASKS });
  assertUniqueName('subjects', 'name', name, id);
  transaction(() => {
    const { changes } = db.prepare('UPDATE subjects SET name = ?, task_count = ? WHERE id = ?')
      .run(name, taskCount, id);
    if (!changes) throw new HttpError(404, 'Предмет не найден');
    // Если задач стало меньше — убираем лишние отметки и темы
    db.prepare('DELETE FROM progress WHERE subject_id = ? AND task_number > ?').run(id, taskCount);
    db.prepare('DELETE FROM task_topics WHERE subject_id = ? AND task_number > ?').run(id, taskCount);
    saveTopics(id, taskCount, req.body?.topics);
  });
  res.json({ ok: true });
});

app.delete('/api/subjects/:id', requireAdmin, requireSuper, (req, res) => {
  const id = int(req.params.id, 'id');
  const { changes } = db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, 'Предмет не найден');
  res.json({ ok: true });
});

// ---------- классы ----------

function setClassSubjects(classId, subjectIds) {
  const exists = db.prepare('SELECT 1 FROM subjects WHERE id = ?');
  for (const sid of subjectIds) {
    if (!exists.get(sid)) throw new HttpError(400, 'Указан несуществующий предмет');
  }
  // Удаляем только убранные предметы, чтобы не потерять отметки по оставшимся
  const current = db.prepare('SELECT subject_id FROM class_subjects WHERE class_id = ?').all(classId)
    .map((r) => r.subject_id);
  const del = db.prepare('DELETE FROM class_subjects WHERE class_id = ? AND subject_id = ?');
  for (const sid of current) if (!subjectIds.includes(sid)) del.run(classId, sid);
  const add = db.prepare('INSERT OR IGNORE INTO class_subjects (class_id, subject_id) VALUES (?, ?)');
  for (const sid of subjectIds) add.run(classId, sid);
}

app.post('/api/classes', requireAdmin, requireSuper, (req, res) => {
  const name = str(req.body?.name, 'Название класса', { max: 30 });
  const subjectIds = idList(req.body?.subject_ids ?? [], 'Предметы');
  assertUniqueName('classes', 'name', name);
  const id = transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO classes (name) VALUES (?)').run(name);
    setClassSubjects(Number(lastInsertRowid), subjectIds);
    return Number(lastInsertRowid);
  });
  res.status(201).json({ id });
});

app.put('/api/classes/:id', requireAdmin, requireSuper, (req, res) => {
  const id = int(req.params.id, 'id');
  const name = str(req.body?.name, 'Название класса', { max: 30 });
  const subjectIds = idList(req.body?.subject_ids ?? [], 'Предметы');
  assertUniqueName('classes', 'name', name, id);
  transaction(() => {
    const { changes } = db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, id);
    if (!changes) throw new HttpError(404, 'Класс не найден');
    setClassSubjects(id, subjectIds);
  });
  res.json({ ok: true });
});

app.delete('/api/classes/:id', requireAdmin, requireSuper, (req, res) => {
  const id = int(req.params.id, 'id');
  const { changes } = db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, 'Класс не найден');
  res.json({ ok: true });
});

// ---------- отметки ----------

app.put('/api/progress', requireAdmin, (req, res) => {
  const classId = int(req.body?.class_id, 'Класс');
  const subjectId = int(req.body?.subject_id, 'Предмет');
  const status = req.body?.status;
  if (!['done', 'in_progress', 'none'].includes(status)) throw new HttpError(400, 'Неверный статус');
  if (!canEditSubject(req.admin, subjectId)) throw new HttpError(403, 'У вас нет прав на этот предмет');

  const subject = db.prepare(`
    SELECT s.task_count FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id
    WHERE cs.class_id = ? AND cs.subject_id = ?
  `).get(classId, subjectId);
  if (!subject) throw new HttpError(400, 'У этого класса нет такого предмета');
  const taskNumber = int(req.body?.task_number, 'Номер задачи', { max: subject.task_count });

  if (status === 'none') {
    db.prepare('DELETE FROM progress WHERE class_id = ? AND subject_id = ? AND task_number = ?')
      .run(classId, subjectId, taskNumber);
    return res.json({ ok: true });
  }

  const markDate = date(req.body?.date || today());
  db.prepare(`
    INSERT INTO progress (class_id, subject_id, task_number, status, date, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (class_id, subject_id, task_number)
    DO UPDATE SET status = excluded.status, date = excluded.date, updated_by = excluded.updated_by
  `).run(classId, subjectId, taskNumber, status, markDate, req.admin.username);
  res.json({ ok: true });
});

// ---------- администраторы ----------

app.get('/api/admins', requireAdmin, requireSuper, (req, res) => {
  const rows = db.prepare('SELECT id, username, is_super, created_at FROM admins ORDER BY username').all();
  res.json(rows.map((r) => ({ ...r, is_super: !!r.is_super, subject_ids: adminSubjectIds(r.id) })));
});

app.post('/api/admins', requireAdmin, requireSuper, (req, res) => {
  const username = str(req.body?.username, 'Логин', { min: 3, max: 40 });
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new HttpError(400, 'Логин может содержать только буквы, цифры, точку, дефис и _');
  }
  const password = str(req.body?.password, 'Пароль', { min: 6, max: 200 });
  const subjectIds = idList(req.body?.subject_ids ?? [], 'Предметы');
  assertUniqueName('admins', 'username', username);
  const id = transaction(() => {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO admins (username, password_hash, is_super) VALUES (?, ?, ?)',
    ).run(username, hashPassword(password), req.body?.is_super ? 1 : 0);
    setAdminSubjects(Number(lastInsertRowid), subjectIds);
    return Number(lastInsertRowid);
  });
  res.status(201).json({ id });
});

app.put('/api/admins/:id', requireAdmin, requireSuper, (req, res) => {
  const id = int(req.params.id, 'id');
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Администратор не найден');

  transaction(() => {
    if (req.body?.password !== undefined) {
      const password = str(req.body.password, 'Пароль', { min: 6, max: 200 });
      db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
      // Выкидываем из всех сессий, кроме текущей
      db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token != ?')
        .run(id, parseCookies(req.headers.cookie).sid);
    }
    if (req.body?.is_super !== undefined) {
      if (id === req.admin.id && !req.body.is_super) {
        throw new HttpError(400, 'Нельзя снять права главного администратора с самого себя');
      }
      db.prepare('UPDATE admins SET is_super = ? WHERE id = ?').run(req.body.is_super ? 1 : 0, id);
    }
    if (req.body?.subject_ids !== undefined) {
      setAdminSubjects(id, idList(req.body.subject_ids, 'Предметы'));
    }
  });
  res.json({ ok: true });
});

app.delete('/api/admins/:id', requireAdmin, requireSuper, (req, res) => {
  const id = int(req.params.id, 'id');
  if (id === req.admin.id) throw new HttpError(400, 'Нельзя удалить самого себя');
  const { changes } = db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, 'Администратор не найден');
  res.json({ ok: true });
});

// ---------- ошибки ----------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Не найдено' });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Неверный JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
  // Прочие ошибки разбора запроса (неверная кодировка и т.п.) — это ошибка клиента, а не сервера
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'Неверный запрос' });
  }
  if (String(err.message).includes('UNIQUE constraint failed')) {
    return res.status(409).json({ error: 'Такое имя уже занято' });
  }
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`Трекер ЕГЭ запущен: http://localhost:${PORT}`);
});
