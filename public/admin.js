// Панель администратора

const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const dialogForm = document.getElementById('dialog-form');

const TABS = [
  { id: 'marks', title: 'Отметки' },
  { id: 'classes', title: 'Классы' },
  { id: 'subjects', title: 'Предметы' },
  { id: 'admins', title: 'Администраторы', superOnly: true },
  { id: 'account', title: 'Мой аккаунт' },
];

const state = {
  me: null,
  data: null,
  index: null,
  admins: [],
  tab: location.hash.slice(1) || 'marks',
  classId: Number(storageGet('adminClassId')) || null,
};

// ---------- запуск и вход ----------

async function init() {
  state.me = await api('GET', 'api/me').catch(() => null);
  const who = document.getElementById('who');
  const logout = document.getElementById('logout');
  if (!state.me) {
    who.hidden = logout.hidden = true;
    renderLogin();
    return;
  }
  who.textContent = state.me.username;
  who.hidden = logout.hidden = false;
  await reload();
}

async function reload() {
  state.data = await api('GET', 'api/data');
  state.index = indexProgress(state.data.progress);
  if (state.me.is_super) state.admins = await api('GET', 'api/admins');
  render();
}

function renderLogin() {
  app.innerHTML = `
    <div class="card login-box">
      <h1 style="margin-bottom:4px">Вход</h1>
      <p class="sub">Для учителей и администраторов</p>
      <form id="login-form">
        <label class="field"><span>Логин</span>
          <input type="text" name="username" autocomplete="username" required autofocus></label>
        <label class="field"><span>Пароль</span>
          <input type="password" name="password" autocomplete="current-password" required></label>
        <button class="primary" style="width:100%">Войти</button>
        <p class="error" id="login-error"></p>
      </form>
    </div>`;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', 'api/login', { username: f.get('username'), password: f.get('password') });
      await init();
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', 'api/logout').catch(() => {});
  state.me = null;
  init();
});

// Если сессия истекла посреди работы — показываем вход
async function act(fn, okMessage) {
  try {
    await fn();
    if (okMessage) toast(okMessage);
    return true;
  } catch (err) {
    if (/войти/.test(err.message)) { state.me = null; init(); }
    toast(err.message, true);
    return false;
  }
}

// ---------- каркас ----------

function render() {
  closePopover();
  const tabs = TABS.filter((t) => !t.superOnly || state.me.is_super);
  if (!tabs.some((t) => t.id === state.tab)) state.tab = 'marks';

  app.innerHTML = `
    <nav class="tabs">${tabs.map((t) => `<button class="tab ${t.id === state.tab ? 'active' : ''}"
      data-tab="${t.id}">${t.title}</button>`).join('')}</nav>
    <div id="tab"></div>`;
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    history.replaceState(null, '', `#${state.tab}`);
    render();
  }));

  const el = document.getElementById('tab');
  ({ marks: renderMarks, classes: renderClasses, subjects: renderSubjects,
    admins: renderAdmins, account: renderAccount })[state.tab](el);
}

// ---------- диалог ----------

function openDialog(title, fieldsHtml, onSubmit, submitLabel = 'Сохранить') {
  dialogForm.innerHTML = `
    <h2>${esc(title)}</h2>
    ${fieldsHtml}
    <p class="error" id="dialog-error"></p>
    <div class="dialog-actions">
      <button type="button" value="cancel" id="dialog-cancel">Отмена</button>
      <button class="primary" value="ok">${esc(submitLabel)}</button>
    </div>`;
  dialogForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = dialogForm.querySelector('button.primary');
    btn.disabled = true;
    try {
      const result = await onSubmit(new FormData(dialogForm));
      if (result !== false) { dialog.close(); await reload(); }
    } catch (err) {
      document.getElementById('dialog-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById('dialog-cancel').onclick = () => dialog.close();
  dialog.showModal();
  dialogForm.querySelector('input, textarea')?.focus();
}

// ---------- вкладка «Отметки» ----------

function renderMarks(el) {
  const { classes, subjects } = state.data;
  if (!classes.length) {
    el.innerHTML = `<div class="empty-state"><strong>Сначала создайте классы и предметы</strong>
      ${subjects.length ? '' : 'Начните с вкладки «Предметы» — задайте предмет и количество задач, '}
      затем добавьте класс во вкладке «Классы».</div>`;
    return;
  }
  if (!classes.some((c) => c.id === state.classId)) state.classId = classes[0].id;
  const cls = classes.find((c) => c.id === state.classId);
  const classSubjects = subjects.filter((s) => cls.subject_ids.includes(s.id));

  el.innerHTML = `
    <div class="chips">${classes.map((c) => `<button class="chip ${c.id === cls.id ? 'active' : ''}"
      data-class="${c.id}">${esc(c.name)}</button>`).join('')}</div>
    <p class="sub">Нажмите на номер задачи, чтобы изменить её статус.</p>
    ${classSubjects.length ? `<div class="cards">${classSubjects.map((s) => {
      const st = subjectStats(s, cls.id, state.index);
      return `<section class="card">
        <div class="card-head">
          <h2>${esc(s.name)}</h2>
          <span class="count">${st.done} из ${st.total}${st.inProgress ? ` · ${st.inProgress} в процессе` : ''}</span>
          <span class="pct">${st.pct}%</span>
        </div>
        ${progressBarHtml(st)}
        ${taskGridHtml(s, cls.id, state.index)}
        ${LEGEND_HTML}
      </section>`;
    }).join('')}</div>`
    : `<div class="empty-state"><strong>У класса ${esc(cls.name)} нет предметов</strong>
      Добавьте их во вкладке «Классы».</div>`}`;

  el.querySelectorAll('[data-class]').forEach((b) => b.addEventListener('click', () => {
    state.classId = Number(b.dataset.class);
    storageSet('adminClassId', state.classId);
    render();
  }));
  el.querySelectorAll('.task').forEach((b) => b.addEventListener('click', () => {
    if (openPopover?.anchor === b) return closePopover();
    const subject = subjects.find((s) => s.id === Number(b.dataset.subject));
    showMarkEditor(b, subject, cls.id, Number(b.dataset.task));
  }));
}

function showMarkEditor(anchor, subject, classId, n) {
  const key = `${classId}:${subject.id}:${n}`;
  const p = state.index.get(key);
  const current = p?.status || 'none';
  const topic = subject.topics[n];

  const pop = showPopover(anchor, `
    <div class="p-title">${esc(subject.name)}, задача ${n}</div>
    ${topic ? `<div class="p-topic">${esc(topic)}</div>` : ''}
    <label class="field" style="margin:8px 0 0"><span>Дата</span>
      <input type="date" id="mark-date" value="${esc(p?.date || todayIso())}" max="${todayIso()}"></label>
    <div class="p-actions">
      ${['done', 'in_progress', 'none'].map((s) => `<button data-status="${s}"
        class="${s === current ? 'current' : ''}"><i class="${s}"></i>${STATUS_LABEL[s]}</button>`).join('')}
    </div>
    ${p?.updated_by ? `<div class="hint" style="margin-top:8px">Отметил(а): ${esc(p.updated_by)}</div>` : ''}
  `);

  pop.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    const status = b.dataset.status;
    const date = pop.querySelector('#mark-date').value || todayIso();
    pop.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    const ok = await act(() => api('PUT', 'api/progress', {
      class_id: classId, subject_id: subject.id, task_number: n, status, date,
    }));
    if (!ok) return closePopover();

    state.data.progress = state.data.progress.filter((x) =>
      !(x.class_id === classId && x.subject_id === subject.id && x.task_number === n));
    if (status !== 'none') {
      state.data.progress.push({ class_id: classId, subject_id: subject.id, task_number: n,
        status, date, updated_by: state.me.username });
    }
    state.index = indexProgress(state.data.progress);
    const scrollY = window.scrollY;
    render();
    window.scrollTo(0, scrollY);
  }));
}

// ---------- вкладка «Классы» ----------

function renderClasses(el) {
  const { classes, subjects } = state.data;
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

  el.innerHTML = `
    <div class="section-head">
      <h2>Классы</h2>
      <span class="spacer"></span>
      <button class="primary" id="add-class">+ Добавить класс</button>
    </div>
    ${classes.length ? `<div class="list">${classes.map((c) => `
      <div class="list-item">
        <span class="name">${esc(c.name)}</span>
        <span class="row" style="gap:6px">${c.subject_ids.length
          ? c.subject_ids.map((id) => `<span class="tag">${esc(subjectName.get(id))}</span>`).join('')
          : '<span class="meta">нет предметов</span>'}</span>
        <span class="actions">
          <button class="small" data-edit="${c.id}">Изменить</button>
          <button class="small danger" data-delete="${c.id}">Удалить</button>
        </span>
      </div>`).join('')}</div>`
    : '<div class="empty-state"><strong>Классов пока нет</strong>Добавьте первый класс, например «11А».</div>'}`;

  el.querySelector('#add-class').addEventListener('click', () => classDialog(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
    classDialog(classes.find((c) => c.id === Number(b.dataset.edit)))));
  el.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    const c = classes.find((x) => x.id === Number(b.dataset.delete));
    if (!confirm(`Удалить класс ${c.name}? Все его отметки тоже будут удалены.`)) return;
    if (await act(() => api('DELETE', `api/classes/${c.id}`), 'Класс удалён')) reload();
  }));
}

function classDialog(cls) {
  const { subjects } = state.data;
  const fields = `
    <label class="field"><span>Название класса</span>
      <input type="text" name="name" required maxlength="30" placeholder="например, 11А" value="${esc(cls?.name || '')}"></label>
    <div class="field"><span class="hint" style="display:block;margin-bottom:6px">Предметы, которые сдаёт класс</span>
      ${subjects.length ? subjects.map((s) => `<label class="check">
        <input type="checkbox" name="subject" value="${s.id}" ${!cls || cls.subject_ids.includes(s.id) ? 'checked' : ''}>
        ${esc(s.name)}</label>`).join('')
        : '<p class="hint">Предметов пока нет — их можно добавить во вкладке «Предметы».</p>'}
    </div>`;

  openDialog(cls ? `Класс ${cls.name}` : 'Новый класс', fields, async (f) => {
    const body = { name: f.get('name'), subject_ids: f.getAll('subject').map(Number) };
    if (cls) {
      const removed = cls.subject_ids.filter((id) => !body.subject_ids.includes(id));
      const losesMarks = state.data.progress.some((p) => p.class_id === cls.id && removed.includes(p.subject_id));
      if (losesMarks && !confirm('Отметки по убранным предметам будут удалены. Продолжить?')) return false;
      await api('PUT', `api/classes/${cls.id}`, body);
    } else {
      const { id } = await api('POST', 'api/classes', body);
      state.classId = id;
    }
    toast('Сохранено');
  });
}

// ---------- вкладка «Предметы» ----------

function renderSubjects(el) {
  const { subjects, classes } = state.data;

  el.innerHTML = `
    <div class="section-head">
      <h2>Предметы</h2>
      <span class="spacer"></span>
      <button class="primary" id="add-subject">+ Добавить предмет</button>
    </div>
    ${subjects.length ? `<div class="list">${subjects.map((s) => {
      const used = classes.filter((c) => c.subject_ids.includes(s.id)).length;
      const topics = Object.keys(s.topics).length;
      return `<div class="list-item">
        <span class="name">${esc(s.name)}</span>
        <span class="meta">${s.task_count} ${plural(s.task_count, 'задача', 'задачи', 'задач')}
          · ${used ? `${used} ${plural(used, 'класс', 'класса', 'классов')}` : 'не назначен классам'}
          ${topics ? ` · тем: ${topics}` : ''}</span>
        <span class="actions">
          <button class="small" data-edit="${s.id}">Изменить</button>
          <button class="small danger" data-delete="${s.id}">Удалить</button>
        </span>
      </div>`;
    }).join('')}</div>`
    : `<div class="empty-state"><strong>Предметов пока нет</strong>
      Добавьте предмет и укажите, сколько в нём задач ЕГЭ (например, профильная математика — 19).</div>`}`;

  el.querySelector('#add-subject').addEventListener('click', () => subjectDialog(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
    subjectDialog(subjects.find((s) => s.id === Number(b.dataset.edit)))));
  el.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    const s = subjects.find((x) => x.id === Number(b.dataset.delete));
    if (!confirm(`Удалить предмет «${s.name}»? Он пропадёт у всех классов вместе с отметками.`)) return;
    if (await act(() => api('DELETE', `api/subjects/${s.id}`), 'Предмет удалён')) reload();
  }));
}

function subjectDialog(subject) {
  const topicsText = subject
    ? Array.from({ length: subject.task_count }, (_, i) => subject.topics[i + 1] || '').join('\n').replace(/\n+$/, '')
    : '';
  const fields = `
    <div class="row">
      <label class="field grow"><span>Название</span>
        <input type="text" name="name" required maxlength="100" placeholder="например, Информатика" value="${esc(subject?.name || '')}"></label>
      <label class="field" style="width:130px"><span>Задач в ЕГЭ</span>
        <input type="number" name="task_count" required min="1" max="100" value="${subject?.task_count || ''}"></label>
    </div>
    <label class="field" style="margin-top:14px"><span>Темы задач (необязательно) — по одной на строку: 1-я строка = задача 1</span>
      <textarea name="topics" rows="8" placeholder="Планиметрия&#10;Векторы&#10;Стереометрия">${esc(topicsText)}</textarea></label>`;

  openDialog(subject ? subject.name : 'Новый предмет', fields, async (f) => {
    const taskCount = Number(f.get('task_count'));
    const lines = String(f.get('topics')).split('\n');
    if (lines.slice(taskCount).some((l) => l.trim())) {
      throw new Error(`Строк с темами больше, чем задач (${taskCount})`);
    }
    const topics = {};
    lines.slice(0, taskCount).forEach((l, i) => { if (l.trim()) topics[i + 1] = l.trim(); });

    if (subject && taskCount < subject.task_count) {
      const lost = state.data.progress.some((p) => p.subject_id === subject.id && p.task_number > taskCount);
      if (lost && !confirm(`Отметки по задачам с ${taskCount + 1} по ${subject.task_count} будут удалены. Продолжить?`)) {
        return false;
      }
    }
    const body = { name: f.get('name'), task_count: taskCount, topics };
    if (subject) await api('PUT', `api/subjects/${subject.id}`, body);
    else await api('POST', 'api/subjects', body);
    toast('Сохранено');
  });
}

// ---------- вкладка «Администраторы» ----------

function renderAdmins(el) {
  el.innerHTML = `
    <div class="section-head">
      <h2>Администраторы</h2>
      <span class="spacer"></span>
      <button class="primary" id="add-admin">+ Добавить</button>
    </div>
    <p class="sub">Все администраторы могут вести классы, предметы и отметки.
      Главные администраторы дополнительно управляют аккаунтами.</p>
    <div class="list">${state.admins.map((a) => `
      <div class="list-item">
        <span class="name">${esc(a.username)}</span>
        ${a.is_super ? '<span class="tag accent">главный</span>' : ''}
        ${a.id === state.me.id ? '<span class="tag">это вы</span>' : ''}
        <span class="actions">
          <button class="small" data-password="${a.id}">Сменить пароль</button>
          ${a.id === state.me.id ? '' : `
            <button class="small" data-super="${a.id}">${a.is_super ? 'Снять «главного»' : 'Сделать главным'}</button>
            <button class="small danger" data-delete="${a.id}">Удалить</button>`}
        </span>
      </div>`).join('')}</div>`;

  const byId = (id) => state.admins.find((a) => a.id === Number(id));

  el.querySelector('#add-admin').addEventListener('click', () => {
    openDialog('Новый администратор', `
      <label class="field"><span>Логин</span>
        <input type="text" name="username" required minlength="3" maxlength="40" autocomplete="off"></label>
      <label class="field"><span>Пароль (минимум 6 символов)</span>
        <input type="text" name="password" required minlength="6" autocomplete="new-password"></label>
      <label class="check"><input type="checkbox" name="is_super"> Главный администратор</label>
      <p class="hint">Передайте логин и пароль учителю — сменить пароль он сможет сам во вкладке «Мой аккаунт».</p>`,
    async (f) => {
      await api('POST', 'api/admins', {
        username: f.get('username'), password: f.get('password'), is_super: f.get('is_super') === 'on',
      });
      toast('Администратор добавлен');
    }, 'Добавить');
  });

  el.querySelectorAll('[data-password]').forEach((b) => b.addEventListener('click', () => {
    const a = byId(b.dataset.password);
    openDialog(`Новый пароль для ${a.username}`, `
      <label class="field"><span>Пароль (минимум 6 символов)</span>
        <input type="text" name="password" required minlength="6" autocomplete="new-password"></label>`,
    async (f) => {
      await api('PUT', `api/admins/${a.id}`, { password: f.get('password') });
      toast('Пароль изменён');
    });
  }));

  el.querySelectorAll('[data-super]').forEach((b) => b.addEventListener('click', async () => {
    const a = byId(b.dataset.super);
    if (await act(() => api('PUT', `api/admins/${a.id}`, { is_super: !a.is_super }), 'Сохранено')) reload();
  }));

  el.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    const a = byId(b.dataset.delete);
    if (!confirm(`Удалить администратора ${a.username}?`)) return;
    if (await act(() => api('DELETE', `api/admins/${a.id}`), 'Удалён')) reload();
  }));
}

// ---------- вкладка «Мой аккаунт» ----------

function renderAccount(el) {
  el.innerHTML = `
    <div class="card" style="max-width:420px">
      <h2 style="margin-bottom:4px">Смена пароля</h2>
      <p class="sub">Вы вошли как <b>${esc(state.me.username)}</b></p>
      <form id="pw-form">
        <label class="field"><span>Текущий пароль</span>
          <input type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>Новый пароль (минимум 6 символов)</span>
          <input type="password" name="password" required minlength="6" autocomplete="new-password"></label>
        <label class="field"><span>Повторите новый пароль</span>
          <input type="password" name="repeat" required minlength="6" autocomplete="new-password"></label>
        <button class="primary">Сменить пароль</button>
        <p class="error" id="pw-error"></p>
      </form>
    </div>`;

  el.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const error = el.querySelector('#pw-error');
    if (f.get('password') !== f.get('repeat')) { error.textContent = 'Пароли не совпадают'; return; }
    try {
      await api('PUT', 'api/me/password', { current: f.get('current'), password: f.get('password') });
      e.target.reset();
      error.textContent = '';
      toast('Пароль изменён');
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

init();
