// Заполнение базы тестовыми данными: предметы с темами, классы, учителя и отметки.
//
//   npm run seed              — заполнить пустую базу
//   npm run seed -- --reset   — удалить все предметы, классы, отметки и тестовых учителей
//                               и заполнить заново (главный администратор остаётся)
//
// Только для локальной проверки и демонстрации! У тестовых учителей общий простой пароль,
// поэтому на настоящем школьном сервере этот скрипт не запускайте.

const { db, hashPassword, transaction, ensureFirstAdmin } = require('./db');

const TEACHER_PASSWORD = 'test1234';
const RESET = process.argv.includes('--reset');

const SUBJECTS = [
  {
    key: 'math',
    name: 'Математика (профиль)',
    topics: [
      'Планиметрия', 'Векторы', 'Стереометрия', 'Начала теории вероятностей',
      'Вероятности сложных событий', 'Простейшие уравнения', 'Вычисления и преобразования',
      'Производная и первообразная', 'Задачи с прикладным содержанием', 'Текстовые задачи',
      'Графики функций', 'Наибольшее и наименьшее значение функций', 'Уравнения',
      'Стереометрическая задача', 'Неравенства', 'Экономическая задача',
      'Планиметрическая задача', 'Задача с параметром', 'Числа и их свойства',
    ],
  },
  {
    key: 'russian',
    name: 'Русский язык',
    topics: [
      'Информационная обработка текста', 'Лексическое значение слова', 'Стилистический анализ текста',
      'Орфоэпические нормы (ударение)', 'Паронимы', 'Лексические нормы', 'Морфологические нормы',
      'Синтаксические нормы', 'Правописание корней', 'Правописание приставок',
      'Правописание суффиксов', 'Личные окончания глаголов и суффиксы причастий',
      'Правописание НЕ и НИ', 'Слитное, дефисное и раздельное написание', 'Н и НН в разных частях речи',
      'Пунктуация в ССП и при однородных членах', 'Обособленные члены предложения',
      'Вводные слова и обращения', 'Пунктуация в СПП', 'Сложное предложение с разными видами связи',
      'Пунктуационный анализ', 'Смысловая и композиционная целостность текста',
      'Функционально-смысловые типы речи', 'Лексический анализ текста',
      'Средства связи предложений в тексте', 'Средства выразительности', 'Сочинение',
    ],
  },
  {
    key: 'informatics',
    name: 'Информатика',
    topics: [
      'Информационные модели (графы)', 'Таблицы истинности', 'Реляционные базы данных',
      'Кодирование и условие Фано', 'Алгоритмы для исполнителей', 'Исполнитель Черепаха',
      'Кодирование изображений и звука', 'Комбинаторика', 'Электронные таблицы',
      'Поиск в текстовом редакторе', 'Количество информации', 'Исполнитель Редактор',
      'IP-адреса и маски', 'Системы счисления', 'Логические выражения', 'Рекурсия',
      'Обработка последовательностей', 'Динамическое программирование в таблицах',
      'Теория игр: один ход', 'Теория игр: два хода', 'Теория игр: стратегия',
      'Параллельные процессы', 'Количество программ', 'Обработка строк',
      'Делители и маски чисел', 'Сортировка и обработка данных', 'Анализ данных',
    ],
  },
  {
    key: 'physics',
    name: 'Физика',
    topics: [
      'Кинематика', 'Динамика', 'Законы сохранения в механике', 'Статика и колебания',
      'Механика: анализ процессов', 'Механика: изменение величин', 'Молекулярная физика',
      'Термодинамика', 'МКТ и термодинамика: анализ', 'МКТ и термодинамика: изменение величин',
      'Электрическое поле и постоянный ток', 'Магнитное поле и электромагнитная индукция',
      'Оптика', 'Электродинамика: анализ процессов', 'Электродинамика: изменение величин',
      'Квантовая физика', 'Квантовая физика: изменение величин', 'Анализ утверждений',
      'Измерения и погрешности', 'Планирование эксперимента', 'Качественная задача',
      'Расчётная задача: механика', 'Расчётная задача: электродинамика',
      'Расчётная задача: молекулярная физика', 'Расчётная задача: оптика',
      'Механика с обоснованием',
    ],
  },
  // Без тем — чтобы было видно, как выглядит предмет, у которого темы не заполнены
  { key: 'social', name: 'Обществознание', taskCount: 25, topics: [] },
];

// Какую долю задач класс уже прошёл: 11-е классы ушли дальше 10-х
const CLASSES = [
  { name: '10А', level: 0.2, subjects: ['math', 'russian', 'physics'] },
  { name: '10Б', level: 0.1, subjects: ['russian', 'social'] },
  { name: '11А', level: 0.65, subjects: ['math', 'russian', 'physics', 'informatics'] },
  { name: '11Б', level: 0.4, subjects: ['math', 'russian', 'social'] },
  { name: '11В', level: 0.5, subjects: ['math', 'russian', 'informatics'] },
];

// Учитель без предметов нужен, чтобы проверить, что он видит подсказку, а не пустую страницу
const TEACHERS = [
  { username: 'ivanova', subjects: ['math'] },
  { username: 'petrova', subjects: ['russian'] },
  { username: 'sidorov', subjects: ['physics', 'informatics'] },
  { username: 'kuznetsova', subjects: ['social'] },
  { username: 'novikov', subjects: [] },
];

// ---------- случайные числа с фиксированным зерном: при каждом запуске одни и те же данные ----------

let seed = 20260901;
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

// ---------- даты ----------

const DAY = 86400000;

function isoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Учебный год начинается 1 сентября; если сейчас лето — берём прошлый сентябрь
function schoolYearStart(now) {
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(year, 8, 1);
}

// Занятия по выходным не ставим — сдвигаем на пятницу
function weekday(d) {
  const day = d.getDay();
  if (day === 6) return new Date(d.getTime() - DAY);
  if (day === 0) return new Date(d.getTime() - 2 * DAY);
  return d;
}

// ---------- проверки ----------

const existing = {
  subjects: db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n,
  classes: db.prepare('SELECT COUNT(*) AS n FROM classes').get().n,
};
if (!RESET && (existing.subjects || existing.classes)) {
  console.error('В базе уже есть предметы или классы — тестовые данные не добавлены.');
  console.error('Чтобы удалить ВСЕ предметы, классы и отметки и заполнить базу заново:');
  console.error('  npm run seed -- --reset');
  process.exit(1);
}

ensureFirstAdmin();

const teacherNames = new Set(TEACHERS.map((t) => t.username.toLocaleLowerCase('ru')));
const clashes = db.prepare('SELECT username, is_super FROM admins').all()
  .filter((a) => teacherNames.has(a.username.toLocaleLowerCase('ru')));
// Главного администратора не трогаем никогда, даже если его логин совпал с тестовым
const superClash = clashes.find((a) => a.is_super);
if (superClash) {
  console.error(`Логин «${superClash.username}» занят главным администратором — переименуйте его или поменяйте логин в seed.js.`);
  process.exit(1);
}
if (clashes.length && !RESET) {
  console.error(`Аккаунты ${clashes.map((a) => a.username).join(', ')} уже есть. Запустите с --reset, чтобы пересоздать их.`);
  process.exit(1);
}

// ---------- заполнение ----------

const summary = transaction(() => {
  if (RESET) {
    // Темы, права, классы-предметы и отметки удалятся каскадом
    db.exec('DELETE FROM classes; DELETE FROM subjects;');
    const del = db.prepare('DELETE FROM admins WHERE username = ? AND is_super = 0');
    for (const a of clashes) del.run(a.username);
  }

  const subjectIds = {};
  const taskCounts = {};
  const addSubject = db.prepare('INSERT INTO subjects (name, task_count) VALUES (?, ?)');
  const addTopic = db.prepare('INSERT INTO task_topics (subject_id, task_number, topic) VALUES (?, ?, ?)');
  for (const s of SUBJECTS) {
    const taskCount = s.taskCount ?? s.topics.length;
    const id = Number(addSubject.run(s.name, taskCount).lastInsertRowid);
    s.topics.slice(0, taskCount).forEach((topic, i) => addTopic.run(id, i + 1, topic.slice(0, 200)));
    subjectIds[s.key] = id;
    taskCounts[s.key] = taskCount;
  }

  const addAdmin = db.prepare('INSERT INTO admins (username, password_hash, is_super) VALUES (?, ?, 0)');
  const addRight = db.prepare('INSERT INTO admin_subjects (admin_id, subject_id) VALUES (?, ?)');
  const teacherOf = {};
  const passwordHash = hashPassword(TEACHER_PASSWORD);
  for (const t of TEACHERS) {
    const id = Number(addAdmin.run(t.username, passwordHash).lastInsertRowid);
    for (const key of t.subjects) {
      addRight.run(id, subjectIds[key]);
      teacherOf[key] ??= t.username;
    }
  }

  const now = new Date();
  const today = startOfDay(now);
  const yearStart = schoolYearStart(now);
  // Отметки ставим не раньше 1 сентября и не позже вчерашнего дня
  const lastDone = new Date(Math.max(yearStart.getTime(), today.getTime() - DAY));
  const span = lastDone.getTime() - yearStart.getTime();

  const addClass = db.prepare('INSERT INTO classes (name) VALUES (?)');
  const addClassSubject = db.prepare('INSERT INTO class_subjects (class_id, subject_id) VALUES (?, ?)');
  const addMark = db.prepare(`INSERT INTO progress (class_id, subject_id, task_number, status, date, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)`);
  let marks = 0;

  for (const c of CLASSES) {
    const classId = Number(addClass.run(c.name).lastInsertRowid);
    for (const key of c.subjects) {
      const subjectId = subjectIds[key];
      const n = taskCounts[key];
      addClassSubject.run(classId, subjectId);

      // Идём по задачам почти по порядку: иногда соседние меняются местами
      const order = Array.from({ length: n }, (_, i) => i + 1);
      for (let i = 0; i < n - 1; i++) {
        if (random() < 0.25) [order[i], order[i + 1]] = [order[i + 1], order[i]];
      }
      const level = Math.min(1, Math.max(0, c.level + (random() - 0.5) * 0.2));
      const done = Math.round(n * level);
      const inProgress = Math.min(n - done, Math.floor(random() * 3));
      const by = teacherOf[key] ?? null;

      for (let i = 0; i < done; i++) {
        // Даты растут вместе с номером в порядке прохождения, с небольшим разбросом
        const t = yearStart.getTime() + span * ((i + 0.5 + (random() - 0.5) * 0.6) / Math.max(done, 1));
        const d = weekday(startOfDay(new Date(Math.min(Math.max(t, yearStart.getTime()), lastDone.getTime()))));
        addMark.run(classId, subjectId, order[i], 'done', isoDate(d < yearStart ? yearStart : d), by);
        marks++;
      }
      for (let i = done; i < done + inProgress; i++) {
        const d = weekday(new Date(today.getTime() - Math.floor(random() * 10) * DAY));
        addMark.run(classId, subjectId, order[i], 'in_progress', isoDate(d < yearStart ? yearStart : d), by);
        marks++;
      }
    }
  }

  return { subjects: SUBJECTS.length, classes: CLASSES.length, teachers: TEACHERS.length, marks };
});

console.log('Тестовые данные добавлены:');
console.log(`  предметов: ${summary.subjects}, классов: ${summary.classes}, отметок: ${summary.marks}`);
console.log(`  учителей: ${summary.teachers} (${TEACHERS.map((t) => t.username).join(', ')}), пароль у всех: ${TEACHER_PASSWORD}`);
