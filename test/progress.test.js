const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let su;

before(async () => {
  await h.start();
  su = await h.loginSuper();
});
after(h.stop);

describe('проверка отметок', () => {
  let subject, cls, other;

  before(async () => {
    subject = await h.createSubject(su, 'Русский язык', 27);
    other = await h.createSubject(su, 'Литература', 11);
    cls = await h.createClass(su, '10А', [subject]);
  });

  it('отклоняет неверный статус, номер задачи и чужой для класса предмет', async () => {
    assert.equal((await h.mark(su, cls, subject, 1, 'finished')).status, 400);
    assert.equal((await h.mark(su, cls, subject, 0)).status, 400);
    assert.equal((await h.mark(su, cls, subject, 28)).status, 400);
    assert.equal((await h.mark(su, cls, subject, 1.5)).status, 400);
    assert.equal((await h.mark(su, cls, other, 1)).status, 400);
    assert.equal((await h.mark(su, 9999, subject, 1)).status, 400);
    assert.deepEqual(h.marksOf(cls, subject), []);
  });

  it('отклоняет несуществующие и будущие даты', async () => {
    assert.equal((await h.mark(su, cls, subject, 1, 'done', '2026-02-30')).status, 400);
    assert.equal((await h.mark(su, cls, subject, 1, 'done', '01.09.2026')).status, 400);
    assert.equal((await h.mark(su, cls, subject, 1, 'done', h.localDate(2))).status, 400);
    // Завтра можно: у учителя может быть другой часовой пояс
    await h.ok(h.mark(su, cls, subject, 1, 'done', h.localDate(1)));
  });

  it('без даты ставит сегодняшнюю', async () => {
    await h.ok(h.mark(su, cls, subject, 2, 'in_progress'));
    assert.equal(h.marksOf(cls, subject).find((m) => m.task_number === 2).date, h.localDate());
  });

  it('меняет статус и дату, а «не начата» удаляет отметку', async () => {
    await h.ok(h.mark(su, cls, subject, 3, 'in_progress', '2026-09-10'));
    await h.ok(h.mark(su, cls, subject, 3, 'done', '2026-09-15'));
    assert.deepEqual(h.marksOf(cls, subject).find((m) => m.task_number === 3),
      { task_number: 3, status: 'done', date: '2026-09-15', updated_by: 'admin' });

    await h.ok(h.mark(su, cls, subject, 3, 'none'));
    assert.equal(h.marksOf(cls, subject).some((m) => m.task_number === 3), false);
    // Повторное «не начата» — не ошибка
    await h.ok(h.mark(su, cls, subject, 3, 'none'));
  });
});

describe('каскадное удаление отметок', () => {
  it('если у класса убрать предмет, его отметки удаляются, остальные остаются', async () => {
    const a = await h.createSubject(su, 'Химия', 34);
    const b = await h.createSubject(su, 'Биология', 28);
    const cls = await h.createClass(su, '11Б', [a, b]);
    await h.ok(h.mark(su, cls, a, 1));
    await h.ok(h.mark(su, cls, b, 1));

    await h.ok(su.put(`/api/classes/${cls}`, { name: '11Б', subject_ids: [b] }));
    assert.deepEqual(h.marksOf(cls, a), []);
    assert.equal(h.marksOf(cls, b).length, 1);

    // Вернули предмет — старые отметки не воскресают
    await h.ok(su.put(`/api/classes/${cls}`, { name: '11Б', subject_ids: [a, b] }));
    assert.deepEqual(h.marksOf(cls, a), []);
  });

  it('удаление класса удаляет его отметки', async () => {
    const s = await h.createSubject(su, 'География', 31);
    const cls = await h.createClass(su, '10В', [s]);
    await h.ok(h.mark(su, cls, s, 1));
    await h.ok(su.del(`/api/classes/${cls}`));
    assert.deepEqual(h.marksOf(cls, s), []);
    assert.equal((await su.del(`/api/classes/${cls}`)).status, 404);
  });

  it('удаление предмета убирает его у классов, отметки и права учителей', async () => {
    const s = await h.createSubject(su, 'История', 21, { 1: 'Древняя Русь' });
    const cls = await h.createClass(su, '11В', [s]);
    const teacher = await h.createTeacher(su, 'historian', [s]);
    await h.ok(h.mark(teacher, cls, s, 1));

    await h.ok(su.del(`/api/subjects/${s}`));
    assert.deepEqual(h.marksOf(cls, s), []);
    assert.deepEqual((await teacher.get('/api/me')).body.subject_ids, []);
    const { body } = await su.get('/api/data');
    assert.deepEqual(body.classes.find((c) => c.id === cls).subject_ids, []);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM task_topics WHERE subject_id = ?').get(s).n, 0);
  });
});

describe('темы задач', () => {
  it('нельзя задать тему для задачи с номером больше числа задач', async () => {
    const res = await su.post('/api/subjects', { name: 'Английский', task_count: 2, topics: { 1: 'a', 3: 'c' } });
    assert.equal(res.status, 400);
    const { body } = await su.get('/api/data');
    assert.equal(body.subjects.some((s) => s.name === 'Английский'), false);
  });
});
