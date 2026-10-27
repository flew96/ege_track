// Общая подготовка для тестов: временная база и сервер на свободном порту.
// node --test запускает каждый файл в отдельном процессе, поэтому у каждого файла своя чистая база.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ege-track-test-'));
process.env.DATA_DIR = dataDir;

const app = require('../server');
const { db, hashPassword } = require('../db');

const SUPER = { username: 'admin', password: 'admin-pass' };
db.prepare('INSERT INTO admins (username, password_hash, is_super) VALUES (?, ?, 1)')
  .run(SUPER.username, hashPassword(SUPER.password));

let server;
let baseUrl;

async function start() {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// raw — тело как есть, чтобы проверить реакцию на битый JSON
async function request(method, url, { body, raw, cookie } = {}) {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(baseUrl + url, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data, headers: res.headers };
}

// Клиент с кукой сессии: client.put('/api/progress', {...})
function client(cookie = null) {
  const call = (method) => (url, body) => request(method, url, { body, cookie });
  return { cookie, get: call('GET'), post: call('POST'), put: call('PUT'), del: call('DELETE') };
}

const anon = client();

async function login(username, password) {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, `вход ${username}: ${JSON.stringify(res.body)}`);
  return client(res.headers.get('set-cookie').split(';')[0]);
}

const loginSuper = () => login(SUPER.username, SUPER.password);

// ---------- заготовки данных через API ----------

async function ok(promise, status = 200) {
  const res = await promise;
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
}

async function createSubject(su, name, taskCount, topics) {
  return (await ok(su.post('/api/subjects', { name, task_count: taskCount, topics }), 201)).id;
}

async function createClass(su, name, subjectIds) {
  return (await ok(su.post('/api/classes', { name, subject_ids: subjectIds }), 201)).id;
}

async function createTeacher(su, username, subjectIds, password = 'teacher-pass') {
  await ok(su.post('/api/admins', { username, password, subject_ids: subjectIds }), 201);
  return login(username, password);
}

function mark(as, classId, subjectId, taskNumber, status = 'done', date) {
  return as.put('/api/progress', { class_id: classId, subject_id: subjectId, task_number: taskNumber, status, date });
}

// Отметки прямо из базы — чтобы проверять результат, не завися от /api/data
function marksOf(classId, subjectId) {
  return db.prepare(`SELECT task_number, status, date, updated_by FROM progress
    WHERE class_id = ? AND subject_id = ? ORDER BY task_number`).all(classId, subjectId)
    .map((r) => ({ ...r }));
}

// Дата в часовом поясе сервера, как её считает server.js
function localDate(offsetDays = 0) {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

module.exports = {
  db, SUPER, start, stop, request, client, anon, login, loginSuper, ok,
  createSubject, createClass, createTeacher, mark, marksOf, localDate,
};
