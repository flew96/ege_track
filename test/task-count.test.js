// Уменьшение числа задач в предмете удаляет отметки по убранным задачам у всех классов,
// поэтому учителю это можно, только пока по этим задачам ничего не отмечено

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let su;

before(async () => {
  await h.start();
  su = await h.loginSuper();
});
after(h.stop);

async function setup(name) {
  const subject = await h.createSubject(su, name, 10, { 1: 'Первая', 9: 'Девятая', 10: 'Десятая' });
  const a = await h.createClass(su, `${name} 11А`, [subject]);
  const b = await h.createClass(su, `${name} 11Б`, [subject]);
  const teacher = await h.createTeacher(su, `t-${name}`, [subject]);
  return { subject, a, b, teacher };
}

function subjectRow(id) {
  return { ...h.db.prepare('SELECT name, task_count FROM subjects WHERE id = ?').get(id) };
}

function topics(id) {
  return h.db.prepare('SELECT task_number FROM task_topics WHERE subject_id = ? ORDER BY task_number').all(id)
    .map((r) => r.task_number);
}

describe('учитель', () => {
  it('может уменьшить число задач, если по убранным задачам нет отметок', async () => {
    const { subject, a, teacher } = await setup('alpha');
    await h.ok(h.mark(teacher, a, subject, 3));

    await h.ok(teacher.put(`/api/subjects/${subject}`, { name: 'alpha', task_count: 8 }));
    assert.equal(subjectRow(subject).task_count, 8);
    assert.deepEqual(topics(subject), [1]);
    assert.equal(h.marksOf(a, subject).length, 1);
  });

  it('не может уменьшить, если в каком-нибудь классе есть отметки по убранным задачам', async () => {
    const { subject, a, b, teacher } = await setup('beta');
    await h.ok(h.mark(teacher, a, subject, 1));
    await h.ok(h.mark(teacher, b, subject, 10, 'in_progress'));

    const res = await teacher.put(`/api/subjects/${subject}`, { name: 'beta (новое)', task_count: 9, topics: {} });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /задаче 10/);
    assert.match(res.body.error, /главный администратор/);

    // Ничего не поменялось: ни название, ни темы, ни отметки
    assert.deepEqual(subjectRow(subject), { name: 'beta', task_count: 10 });
    assert.deepEqual(topics(subject), [1, 9, 10]);
    assert.equal(h.marksOf(a, subject).length, 1);
    assert.equal(h.marksOf(b, subject).length, 1);
  });

  it('в ошибке называет диапазон убираемых задач', async () => {
    const { subject, a, teacher } = await setup('gamma');
    await h.ok(h.mark(teacher, a, subject, 9));
    const res = await teacher.put(`/api/subjects/${subject}`, { name: 'gamma', task_count: 5 });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /задачам 6–10/);
  });

  it('может увеличить число задач — отметки сохраняются', async () => {
    const { subject, a, teacher } = await setup('delta');
    await h.ok(h.mark(teacher, a, subject, 10));
    await h.ok(teacher.put(`/api/subjects/${subject}`, { name: 'delta', task_count: 12 }));
    assert.equal(subjectRow(subject).task_count, 12);
    assert.equal(h.marksOf(a, subject).length, 1);
  });

  it('может сохранить предмет с тем же числом задач, даже если всё отмечено', async () => {
    const { subject, a, teacher } = await setup('epsilon');
    await h.ok(h.mark(teacher, a, subject, 10));
    await h.ok(teacher.put(`/api/subjects/${subject}`, { name: 'epsilon 2', task_count: 10 }));
    assert.equal(subjectRow(subject).name, 'epsilon 2');
  });
});

describe('главный администратор', () => {
  it('может уменьшить число задач с отметками — лишние отметки и темы удаляются', async () => {
    const { subject, a, b, teacher } = await setup('zeta');
    await h.ok(h.mark(teacher, a, subject, 2));
    await h.ok(h.mark(teacher, a, subject, 9));
    await h.ok(h.mark(teacher, b, subject, 10));

    await h.ok(su.put(`/api/subjects/${subject}`, { name: 'zeta', task_count: 8 }));
    assert.equal(subjectRow(subject).task_count, 8);
    assert.deepEqual(h.marksOf(a, subject).map((m) => m.task_number), [2]);
    assert.deepEqual(h.marksOf(b, subject), []);
    assert.deepEqual(topics(subject), [1]);
  });

  it('удалённые так отметки попадают в журнал', async () => {
    const { subject, a, teacher } = await setup('eta');
    await h.ok(h.mark(teacher, a, subject, 10, 'done', '2026-10-01'));
    await h.ok(su.put(`/api/subjects/${subject}`, { name: 'eta', task_count: 9 }));

    const { entries } = (await su.get(`/api/history?subject_id=${subject}`)).body;
    assert.equal(entries.length, 2);
    const { id, changed_at, ...removal } = entries[0];
    assert.deepEqual(removal, {
      class_id: a, subject_id: subject, task_number: 10,
      old_status: 'done', old_date: '2026-10-01', new_status: null, new_date: null,
      changed_by: 'admin', is_latest: true,
    });
  });
});
