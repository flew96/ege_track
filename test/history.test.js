const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let su, teacher, math, physics, a, b;

before(async () => {
  await h.start();
  su = await h.loginSuper();
  math = await h.createSubject(su, 'Математика', 19);
  physics = await h.createSubject(su, 'Физика', 26);
  a = await h.createClass(su, '11А', [math, physics]);
  b = await h.createClass(su, '11Б', [math]);
  teacher = await h.createTeacher(su, 'ivanova', [math]);
});
after(h.stop);

async function history(query = '') {
  return h.ok(su.get(`/api/history${query}`));
}

function logCount() {
  return h.db.prepare('SELECT COUNT(*) AS n FROM progress_log').get().n;
}

// Запись журнала без id и времени — их удобно сравнивать целиком
function entry({ id, changed_at, ...rest }) {
  return rest;
}

describe('журнал изменений', () => {
  it('записывает, кто, когда и что поменял', async () => {
    const t0 = Date.now();
    await h.ok(h.mark(teacher, a, math, 1, 'in_progress', '2026-10-01'));
    await h.ok(h.mark(teacher, a, math, 1, 'done', '2026-10-05'));

    const { entries, has_more } = await history(`?class_id=${a}&subject_id=${math}`);
    assert.equal(has_more, false);
    assert.deepEqual(entries.map(entry), [
      { class_id: a, subject_id: math, task_number: 1, old_status: 'in_progress', old_date: '2026-10-01',
        new_status: 'done', new_date: '2026-10-05', changed_by: 'ivanova', is_latest: true },
      { class_id: a, subject_id: math, task_number: 1, old_status: null, old_date: null,
        new_status: 'in_progress', new_date: '2026-10-01', changed_by: 'ivanova', is_latest: false },
    ]);
    assert.ok(entries[0].id > entries[1].id);
    for (const e of entries) assert.ok(e.changed_at >= t0 && e.changed_at <= Date.now());
  });

  it('снятие отметки тоже записывается', async () => {
    await h.ok(h.mark(teacher, a, math, 1, 'none'));
    const [last] = (await history(`?class_id=${a}&subject_id=${math}`)).entries;
    assert.deepEqual(entry(last), {
      class_id: a, subject_id: math, task_number: 1, old_status: 'done', old_date: '2026-10-05',
      new_status: null, new_date: null, changed_by: 'ivanova', is_latest: true,
    });
  });

  it('повторное нажатие на тот же статус и дату не попадает в журнал', async () => {
    const before = logCount();
    await h.ok(h.mark(teacher, a, math, 2, 'done', '2026-10-10'));
    await h.ok(h.mark(teacher, a, math, 2, 'done', '2026-10-10'));
    await h.ok(h.mark(teacher, a, math, 3, 'none'));
    assert.equal(logCount(), before + 1);

    // А смена только даты — попадает
    await h.ok(h.mark(teacher, a, math, 2, 'done', '2026-10-11'));
    assert.equal(logCount(), before + 2);
  });

  it('отклонённое изменение в журнал не попадает', async () => {
    const before = logCount();
    assert.equal((await h.mark(teacher, a, physics, 1)).status, 403);
    assert.equal((await h.mark(teacher, a, math, 1, 'done', h.localDate(5))).status, 400);
    assert.equal(logCount(), before);
  });

  it('фильтрует по классу и предмету', async () => {
    await h.ok(h.mark(su, b, math, 7));
    await h.ok(h.mark(su, a, physics, 7));
    const byClass = (await history(`?class_id=${b}`)).entries;
    assert.ok(byClass.length > 0);
    assert.ok(byClass.every((e) => e.class_id === b));
    const bySubject = (await history(`?subject_id=${physics}`)).entries;
    assert.ok(bySubject.length > 0);
    assert.ok(bySubject.every((e) => e.subject_id === physics));
  });

  it('отдаёт записи страницами', async () => {
    for (let n = 10; n <= 14; n++) await h.ok(h.mark(su, b, math, n));
    const all = (await history(`?class_id=${b}`)).entries;
    assert.equal(all.length, 6);

    const first = await history(`?class_id=${b}&limit=4`);
    assert.equal(first.has_more, true);
    const second = await history(`?class_id=${b}&limit=4&before=${first.entries.at(-1).id}`);
    assert.equal(second.has_more, false);
    assert.deepEqual([...first.entries, ...second.entries].map((e) => e.id), all.map((e) => e.id));
  });

  it('проверяет параметры запроса', async () => {
    assert.equal((await su.get('/api/history?class_id=abc')).status, 400);
    assert.equal((await su.get('/api/history?limit=1000')).status, 400);
    assert.equal((await su.get('/api/history?limit=0')).status, 400);
  });

  it('отмена: повторная отметка со старыми значениями возвращает всё как было', async () => {
    await h.ok(h.mark(teacher, a, math, 5, 'done', '2026-10-02'));
    await h.ok(h.mark(teacher, a, math, 5, 'in_progress', '2026-10-20'));
    const [latest] = (await history(`?class_id=${a}&subject_id=${math}`)).entries;
    assert.equal(latest.is_latest, true);

    // Так отменяет кнопка «Отменить» во вкладке «История»
    await h.ok(h.mark(su, a, math, 5, latest.old_status, latest.old_date));
    assert.deepEqual(h.marksOf(a, math).find((m) => m.task_number === 5),
      { task_number: 5, status: 'done', date: '2026-10-02', updated_by: 'admin' });

    const [revert, previous] = (await history(`?class_id=${a}&subject_id=${math}`)).entries;
    assert.equal(revert.changed_by, 'admin');
    assert.equal(revert.new_status, 'done');
    assert.equal(revert.is_latest, true);
    assert.equal(previous.is_latest, false);
  });

  it('если у класса убрать предмет, снятые отметки записываются в журнал', async () => {
    await h.ok(h.mark(su, a, physics, 20, 'in_progress', '2026-10-15'));
    const marked = h.marksOf(a, physics).length;
    await h.ok(su.put(`/api/classes/${a}`, { name: '11А', subject_ids: [math] }));

    const entries = (await history(`?class_id=${a}&subject_id=${physics}`)).entries;
    const removals = entries.filter((e) => e.new_status === null && e.changed_by === 'admin');
    assert.equal(removals.length, marked);
    assert.ok(removals.some((e) => e.task_number === 20 && e.old_status === 'in_progress' && e.old_date === '2026-10-15'));
  });

  it('при удалении класса его записи из журнала удаляются', async () => {
    const cls = await h.createClass(su, '9А', [math]);
    await h.ok(h.mark(su, cls, math, 1));
    assert.equal((await history(`?class_id=${cls}`)).entries.length, 1);
    await h.ok(su.del(`/api/classes/${cls}`));
    assert.equal((await history(`?class_id=${cls}`)).entries.length, 0);
  });
});
