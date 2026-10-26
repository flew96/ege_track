// Публичная страница: просмотр пройденных задач

const app = document.getElementById('app');

const state = {
  data: null,
  index: null,
  view: storageGet('view') || 'class',       // class | compare
  layout: storageGet('layout') || 'grid',    // grid | list
  classId: Number(storageGet('classId')) || null,
  subjectId: Number(storageGet('subjectId')) || null,
};

async function load() {
  try {
    state.data = await api('GET', 'api/data');
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить данные</strong>${esc(err.message)}</div>`;
    return;
  }
  state.index = indexProgress(state.data.progress);
  if (state.data.admin) document.getElementById('admin-link').textContent = 'Панель управления';
  render();
}

function render() {
  closePopover();
  const { classes, subjects } = state.data;

  if (!classes.length) {
    app.innerHTML = `<div class="empty-state"><strong>Пока нет ни одного класса</strong>
      Учитель ещё не добавил классы и предметы.</div>`;
    return;
  }

  if (!classes.some((c) => c.id === state.classId)) state.classId = classes[0].id;
  const usedSubjects = subjects.filter((s) => classes.some((c) => c.subject_ids.includes(s.id)));
  if (!usedSubjects.some((s) => s.id === state.subjectId)) state.subjectId = usedSubjects[0]?.id ?? null;

  app.innerHTML = `
    <div class="row" style="margin-bottom:20px; align-items:center">
      <div class="grow">
        <h1>Пройденные задачи ЕГЭ</h1>
      </div>
      <div class="segmented">
        ${segButton('view', 'class', 'По классу')}
        ${segButton('view', 'compare', 'Сравнить классы')}
      </div>
    </div>
    <div id="view"></div>`;

  app.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    storageSet('view', state.view);
    render();
  }));

  const view = document.getElementById('view');
  if (state.view === 'compare') renderCompare(view, usedSubjects);
  else renderClass(view);
}

function segButton(key, value, title) {
  const active = state[key] === value;
  return `<button data-${key}="${value}" class="${active ? 'active' : ''}" aria-pressed="${active}">${title}</button>`;
}

// ---------- вид «по классу» ----------

function renderClass(view) {
  const { classes, subjects } = state.data;
  const cls = classes.find((c) => c.id === state.classId);
  const classSubjects = subjects.filter((s) => cls.subject_ids.includes(s.id));

  let totalDone = 0, totalTasks = 0;
  const stats = classSubjects.map((s) => {
    const st = subjectStats(s, cls.id, state.index);
    totalDone += st.done;
    totalTasks += st.total;
    return st;
  });

  const chips = classes.map((c) => `<button class="chip ${c.id === cls.id ? 'active' : ''}"
    data-class="${c.id}">${esc(c.name)}</button>`).join('');

  let body;
  if (!classSubjects.length) {
    body = `<div class="empty-state"><strong>У класса ${esc(cls.name)} пока нет предметов</strong></div>`;
  } else {
    body = `
      <div class="summary">
        <div>
          <div class="big">${totalTasks ? Math.round((totalDone / totalTasks) * 100) : 0}%</div>
          <div class="label">всего пройдено</div>
        </div>
        <div>
          <div class="big">${totalDone}<span style="color:var(--muted);font-weight:600"> / ${totalTasks}</span></div>
          <div class="label">${plural(totalTasks, 'задача', 'задачи', 'задач')}</div>
        </div>
        <span class="spacer"></span>
        <div class="segmented">
          ${segButton('layout', 'grid', 'Сетка')}
          ${segButton('layout', 'list', 'Список')}
        </div>
      </div>
      <div class="cards">
        ${classSubjects.map((s, i) => subjectCardHtml(s, cls.id, stats[i])).join('')}
      </div>`;
  }

  view.innerHTML = `<div class="chips">${chips}</div>${body}`;

  view.querySelectorAll('[data-class]').forEach((b) => b.addEventListener('click', () => {
    state.classId = Number(b.dataset.class);
    storageSet('classId', state.classId);
    render();
  }));
  view.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => {
    state.layout = b.dataset.layout;
    storageSet('layout', state.layout);
    render();
  }));
  view.querySelectorAll('.task').forEach((b) => b.addEventListener('click', () => {
    const subject = subjects.find((s) => s.id === Number(b.dataset.subject));
    showTaskInfo(b, subject, cls.id, Number(b.dataset.task));
  }));
}

function subjectCardHtml(subject, classId, stats) {
  const content = state.layout === 'list'
    ? taskListHtml(subject, classId)
    : taskGridHtml(subject, classId, state.index) + LEGEND_HTML;
  return `<section class="card">
    <div class="card-head">
      <h2>${esc(subject.name)}</h2>
      <span class="count">${stats.done} из ${stats.total}${stats.inProgress ? ` · ${stats.inProgress} в процессе` : ''}</span>
      <span class="pct">${stats.pct}%</span>
    </div>
    ${progressBarHtml(stats)}
    ${content}
  </section>`;
}

function taskListHtml(subject, classId) {
  let html = '<ul class="tasklist">';
  for (let n = 1; n <= subject.task_count; n++) {
    const p = state.index.get(`${classId}:${subject.id}:${n}`);
    const status = p?.status || 'none';
    const topic = subject.topics[n];
    html += `<li>
      <span class="num">${n}</span>
      <span class="topic ${topic ? '' : 'empty'}">${topic ? esc(topic) : 'Без темы'}</span>
      <span class="badge ${status}">${STATUS_LABEL[status]}${p ? ` · ${esc(shortDate(p.date))}` : ''}</span>
    </li>`;
  }
  return html + '</ul>';
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function showTaskInfo(anchor, subject, classId, n) {
  if (openPopover?.anchor === anchor) return closePopover();
  const p = state.index.get(`${classId}:${subject.id}:${n}`);
  const status = p?.status || 'none';
  const topic = subject.topics[n];
  showPopover(anchor, `
    <div class="p-title">${esc(subject.name)}, задача ${n}</div>
    ${topic ? `<div class="p-topic">${esc(topic)}</div>` : ''}
    <span class="badge ${status}">${STATUS_LABEL[status]}</span>
    ${p ? `<div class="hint" style="margin-top:6px">${status === 'done' ? 'Дата:' : 'Начали'} ${esc(formatDate(p.date))}</div>` : ''}
  `);
}

// ---------- вид «сравнение классов» ----------

function renderCompare(view, usedSubjects) {
  const { classes } = state.data;
  if (!usedSubjects.length) {
    view.innerHTML = '<div class="empty-state"><strong>Ни у одного класса пока нет предметов</strong></div>';
    return;
  }

  const subject = usedSubjects.find((s) => s.id === state.subjectId);
  const chips = usedSubjects.map((s) => `<button class="chip ${s.id === subject.id ? 'active' : ''}"
    data-subject="${s.id}">${esc(s.name)}</button>`).join('');

  const rows = classes.filter((c) => c.subject_ids.includes(subject.id)).map((c) => {
    const st = subjectStats(subject, c.id, state.index);
    let cells = '';
    for (let n = 1; n <= subject.task_count; n++) {
      const p = state.index.get(`${c.id}:${subject.id}:${n}`);
      const status = p?.status || 'none';
      const title = `${c.name}, задача ${n} — ${STATUS_LABEL[status]}${p ? `, ${formatDate(p.date)}` : ''}`;
      cells += `<td><div class="cell ${status}" title="${esc(title)}"></div></td>`;
    }
    return `<tr><td class="cls">${esc(c.name)}</td>${cells}<td class="pct">${st.done}/${st.total} · ${st.pct}%</td></tr>`;
  }).join('');

  let head = '<th class="cls">Класс</th>';
  for (let n = 1; n <= subject.task_count; n++) {
    head += `<th title="${esc(subject.topics[n] || '')}">${n}</th>`;
  }

  view.innerHTML = `
    <div class="chips">${chips}</div>
    <div class="table-scroll">
      <table class="compare">
        <thead><tr>${head}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${LEGEND_HTML}`;

  view.querySelectorAll('[data-subject]').forEach((b) => b.addEventListener('click', () => {
    state.subjectId = Number(b.dataset.subject);
    storageSet('subjectId', state.subjectId);
    render();
  }));
}

load();
