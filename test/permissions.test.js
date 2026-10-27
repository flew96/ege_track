const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let su, math, physics, cls, teacher;

before(async () => {
  await h.start();
  su = await h.loginSuper();
  math = await h.createSubject(su, 'Математика', 19);
  physics = await h.createSubject(su, 'Физика', 26);
  cls = await h.createClass(su, '11А', [math, physics]);
  teacher = await h.createTeacher(su, 'ivanova', [math]);
});
after(h.stop);

describe('без входа', () => {
  it('видно все данные, кроме того, кто ставил отметки', async () => {
    await h.ok(h.mark(su, cls, math, 1));
    const { body } = await h.anon.get('/api/data');
    assert.equal(body.admin, null);
    assert.deepEqual(body.subjects.map((s) => s.name), ['Математика', 'Физика']);
    const p = body.progress.find((x) => x.subject_id === math && x.task_number === 1);
    assert.equal(p.status, 'done');
    assert.equal('updated_by' in p, false);
  });

  it('ничего нельзя менять', async () => {
    assert.equal((await h.mark(h.anon, cls, math, 2)).status, 401);
    assert.equal((await h.anon.post('/api/subjects', { name: 'X', task_count: 1 })).status, 401);
    assert.equal((await h.anon.del(`/api/classes/${cls}`)).status, 401);
    assert.equal((await h.anon.get('/api/admins')).status, 401);
    assert.equal((await h.anon.get('/api/history')).status, 401);
  });
});

describe('учитель', () => {
  it('отмечает задачи своего предмета и видит, кто их отметил', async () => {
    await h.ok(h.mark(teacher, cls, math, 5, 'in_progress'));
    assert.equal(h.marksOf(cls, math).find((m) => m.task_number === 5).updated_by, 'ivanova');
    const { body } = await teacher.get('/api/data');
    assert.equal(body.admin.username, 'ivanova');
    assert.equal(body.progress.find((x) => x.task_number === 5).updated_by, 'ivanova');
  });

  it('не может отмечать чужой предмет', async () => {
    const res = await h.mark(teacher, cls, physics, 1);
    assert.equal(res.status, 403);
    assert.deepEqual(h.marksOf(cls, physics), []);
  });

  it('меняет название и темы своего предмета, но не чужого', async () => {
    await h.ok(teacher.put(`/api/subjects/${math}`, { name: 'Математика (профиль)', task_count: 19, topics: { 1: 'Планиметрия' } }));
    const { body } = await h.anon.get('/api/data');
    const s = body.subjects.find((x) => x.id === math);
    assert.equal(s.name, 'Математика (профиль)');
    assert.deepEqual(s.topics, { 1: 'Планиметрия' });

    const res = await teacher.put(`/api/subjects/${physics}`, { name: 'Физика!', task_count: 26 });
    assert.equal(res.status, 403);
  });

  it('не может создавать и удалять предметы, классы и администраторов', async () => {
    assert.equal((await teacher.post('/api/subjects', { name: 'Химия', task_count: 30 })).status, 403);
    assert.equal((await teacher.del(`/api/subjects/${math}`)).status, 403);
    assert.equal((await teacher.post('/api/classes', { name: '9А', subject_ids: [] })).status, 403);
    assert.equal((await teacher.put(`/api/classes/${cls}`, { name: '11А', subject_ids: [math] })).status, 403);
    assert.equal((await teacher.del(`/api/classes/${cls}`)).status, 403);
    assert.equal((await teacher.get('/api/admins')).status, 403);
    assert.equal((await teacher.post('/api/admins', { username: 'hacker', password: '123456', is_super: true })).status, 403);
  });

  it('не может видеть журнал изменений', async () => {
    assert.equal((await teacher.get('/api/history')).status, 403);
  });

  it('новые права действуют сразу, без повторного входа', async () => {
    const { id } = (await teacher.get('/api/me')).body;
    await h.ok(su.put(`/api/admins/${id}`, { subject_ids: [math, physics] }));
    await h.ok(h.mark(teacher, cls, physics, 1));

    await h.ok(su.put(`/api/admins/${id}`, { subject_ids: [math] }));
    assert.equal((await h.mark(teacher, cls, physics, 2)).status, 403);
  });

  it('после удаления аккаунта сессия перестаёт работать', async () => {
    const temp = await h.createTeacher(su, 'temp', [math]);
    const { id } = (await temp.get('/api/me')).body;
    await h.ok(su.del(`/api/admins/${id}`));
    assert.equal((await h.mark(temp, cls, math, 3)).status, 401);
  });
});

describe('главный администратор', () => {
  it('может отмечать любой предмет', async () => {
    await h.ok(h.mark(su, cls, physics, 10));
  });

  it('не может удалить себя или снять с себя права главного', async () => {
    const { id } = (await su.get('/api/me')).body;
    assert.equal((await su.del(`/api/admins/${id}`)).status, 400);
    assert.equal((await su.put(`/api/admins/${id}`, { is_super: false })).status, 400);
    assert.equal((await su.get('/api/me')).body.is_super, true);
  });

  it('названия классов и предметов уникальны без учёта регистра, в том числе кириллицы', async () => {
    assert.equal((await su.post('/api/classes', { name: '11а', subject_ids: [] })).status, 409);
    assert.equal((await su.post('/api/subjects', { name: 'ФИЗИКА', task_count: 5 })).status, 409);
    assert.equal((await su.post('/api/admins', { username: 'IVANOVA', password: '123456' })).status, 409);
  });
});
