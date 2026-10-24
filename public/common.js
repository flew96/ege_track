// Общие функции для публичной страницы и админки

const STATUS_LABEL = { done: 'Пройдена', in_progress: 'В процессе', none: 'Не начата' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Индекс отметок: "classId:subjectId:task" -> запись
function indexProgress(progress) {
  const map = new Map();
  for (const p of progress) map.set(`${p.class_id}:${p.subject_id}:${p.task_number}`, p);
  return map;
}

function subjectStats(subject, classId, progressIndex) {
  let done = 0, inProgress = 0;
  for (let n = 1; n <= subject.task_count; n++) {
    const p = progressIndex.get(`${classId}:${subject.id}:${n}`);
    if (p?.status === 'done') done++;
    else if (p?.status === 'in_progress') inProgress++;
  }
  const total = subject.task_count;
  return { done, inProgress, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function progressBarHtml(stats) {
  const w = (n) => (stats.total ? (n / stats.total) * 100 : 0);
  return `<div class="bar" role="img" aria-label="Пройдено ${stats.done} из ${stats.total}">
    <div class="done" style="width:${w(stats.done)}%"></div>
    <div class="in_progress" style="width:${w(stats.inProgress)}%"></div>
  </div>`;
}

function taskGridHtml(subject, classId, progressIndex) {
  let html = '<div class="grid">';
  for (let n = 1; n <= subject.task_count; n++) {
    const p = progressIndex.get(`${classId}:${subject.id}:${n}`);
    const status = p?.status || 'none';
    const topic = subject.topics[n];
    const label = `Задача ${n}${topic ? `: ${topic}` : ''} — ${STATUS_LABEL[status]}`;
    html += `<button class="task ${status}" data-subject="${subject.id}" data-task="${n}"
      aria-label="${esc(label)}">${n}</button>`;
  }
  return html + '</div>';
}

const LEGEND_HTML = `<div class="legend">
  <span><i class="done"></i>Пройдена</span>
  <span><i class="in_progress"></i>В процессе</span>
  <span><i></i>Не начата</span>
</div>`;

// ---------- всплывашка у задачи ----------

let openPopover = null;

function closePopover() {
  if (!openPopover) return;
  openPopover.anchor.classList.remove('selected');
  openPopover.el.remove();
  openPopover = null;
}

function showPopover(anchor, html) {
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.innerHTML = html;
  document.body.appendChild(el);

  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  let left = r.left + window.scrollX + r.width / 2 - w / 2;
  left = Math.max(16 + window.scrollX, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 16));
  let top = r.bottom + window.scrollY + 8;
  if (r.bottom + el.offsetHeight + 16 > window.innerHeight && r.top > el.offsetHeight + 16) {
    top = r.top + window.scrollY - el.offsetHeight - 8;
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  anchor.classList.add('selected');
  openPopover = { el, anchor };
  return el;
}

document.addEventListener('click', (e) => {
  if (openPopover && !openPopover.el.contains(e.target) && !openPopover.anchor.contains(e.target)) closePopover();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
window.addEventListener('resize', closePopover);

// ---------- уведомления ----------

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 4000 : 2200);
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* приватный режим и т.п. */ }
}
