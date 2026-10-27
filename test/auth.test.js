const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

describe('вход и сессии', () => {
  it('пускает с верным паролем и ставит защищённую куку', async () => {
    const res = await h.request('POST', '/api/login', { body: h.SUPER });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'admin');
    assert.equal(res.body.is_super, true);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /^sid=[0-9a-f]{64};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it('логин не зависит от регистра', async () => {
    const res = await h.request('POST', '/api/login', { body: { username: 'ADMIN', password: h.SUPER.password } });
    assert.equal(res.status, 200);
  });

  it('на неверный пароль и несуществующий логин отвечает одинаково', async () => {
    const wrong = await h.request('POST', '/api/login', { body: { username: 'admin', password: 'nope-nope' } });
    const unknown = await h.request('POST', '/api/login', { body: { username: 'ghost', password: 'nope-nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it('/api/me без входа возвращает null, с входом — пользователя', async () => {
    assert.equal((await h.anon.get('/api/me')).body, null);
    const su = await h.loginSuper();
    const me = (await su.get('/api/me')).body;
    assert.equal(me.username, 'admin');
    assert.deepEqual(me.subject_ids, []);
  });

  it('после выхода сессия больше не действует', async () => {
    const su = await h.loginSuper();
    await h.ok(su.post('/api/logout'));
    assert.equal((await su.get('/api/me')).body, null);
    assert.equal((await su.get('/api/admins')).status, 401);
  });

  it('битая кука не роняет сервер', async () => {
    const res = await h.request('GET', '/api/me', { cookie: 'sid=%E0%A4%A' });
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });
});

describe('защита от перебора паролей', () => {
  it('после 10 ошибок блокирует пару «логин + IP», даже с верным паролем', async () => {
    const su = await h.loginSuper();
    await h.createTeacher(su, 'victim', [], 'victim-pass');

    for (let i = 0; i < 10; i++) {
      const res = await h.request('POST', '/api/login', { body: { username: 'victim', password: `wrong-${i}` } });
      assert.equal(res.status, 401);
    }
    const blocked = await h.request('POST', '/api/login', { body: { username: 'Victim', password: 'victim-pass' } });
    assert.equal(blocked.status, 429);

    // Другим учителям с того же адреса (общий NAT в школе) войти можно
    await h.loginSuper();
  });

  it('удачный вход сбрасывает счётчик ошибок', async () => {
    const su = await h.loginSuper();
    await h.createTeacher(su, 'forgetful', [], 'right-pass');
    for (let i = 0; i < 9; i++) {
      await h.request('POST', '/api/login', { body: { username: 'forgetful', password: 'wrong-pass' } });
    }
    await h.login('forgetful', 'right-pass');
    for (let i = 0; i < 9; i++) {
      await h.request('POST', '/api/login', { body: { username: 'forgetful', password: 'wrong-pass' } });
    }
    await h.login('forgetful', 'right-pass');
  });
});

describe('смена пароля', () => {
  it('свой пароль: нужен текущий, другие сессии сбрасываются', async () => {
    const su = await h.loginSuper();
    const teacher = await h.createTeacher(su, 'changer', [], 'old-pass');
    const otherDevice = await h.login('changer', 'old-pass');

    const wrong = await teacher.put('/api/me/password', { current: 'not-it', password: 'new-pass' });
    assert.equal(wrong.status, 400);
    const short = await teacher.put('/api/me/password', { current: 'old-pass', password: '123' });
    assert.equal(short.status, 400);

    await h.ok(teacher.put('/api/me/password', { current: 'old-pass', password: 'new-pass' }));
    assert.equal((await teacher.get('/api/me')).body.username, 'changer');
    assert.equal((await otherDevice.get('/api/me')).body, null);

    assert.equal((await h.request('POST', '/api/login', { body: { username: 'changer', password: 'old-pass' } })).status, 401);
    await h.login('changer', 'new-pass');
  });

  it('главный меняет пароль учителю — все сессии учителя сбрасываются', async () => {
    const su = await h.loginSuper();
    const teacher = await h.createTeacher(su, 'reset-me', [], 'old-pass');
    const { id } = (await teacher.get('/api/me')).body;

    await h.ok(su.put(`/api/admins/${id}`, { password: 'fresh-pass' }));
    assert.equal((await teacher.get('/api/me')).body, null);
    assert.equal((await su.get('/api/me')).body.username, 'admin');
    await h.login('reset-me', 'fresh-pass');
  });
});

describe('ошибки запросов', () => {
  it('неизвестный адрес API — 404 в JSON', async () => {
    const res = await h.anon.get('/api/nothing-here');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
  });

  it('битый JSON — 400, а не 500', async () => {
    const res = await h.request('POST', '/api/login', { raw: '{"username": ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Неверный JSON');
  });

  it('вход без тела запроса — 400, а не 500', async () => {
    const res = await h.request('POST', '/api/login');
    assert.equal(res.status, 400);
  });
});
