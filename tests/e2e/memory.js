// Сквозная проверка этапа 3: долговременная память.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();

async function send(page, text) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Пустая память ---
  await page.click('#memory-btn');
  await page.waitForSelector('#memory-view:not([hidden])');
  assert(page.url().endsWith('#/memory'), 'адрес #/memory');
  assert(await page.isHidden('#composer'), 'на странице памяти поле ввода чата скрыто');
  await page.waitForSelector('.memory-empty');
  assert((await page.textContent('.memory-empty')).includes('Пока пусто'), 'пустое состояние');
  assert((await page.textContent('#memory-sub')).startsWith('Что Джарвис знает о вас'), 'подзаголовок с именем');

  // --- Автозапоминание из чата ---
  await page.click('#new-chat-btn');
  assert(await page.isVisible('#composer'), 'вернулись в чат');
  await send(page, 'Привет! Меня зовут Олег, я учусь на 2 курсе и пишу на JavaScript');
  await page.waitForSelector('.memory-note', { timeout: 10000 });
  const notes = await page.$$eval('.memory-note .note-text', (n) => n.map((x) => x.textContent));
  console.log('  отметки:', notes);
  assert(notes.length === 3 && notes[0].includes('Запомнил') && notes[0].includes('Зовут Олег'), '«💾 Запомнил» под ответом');
  assert(await page.isEnabled('#input'), 'поле ввода доступно, пока идёт запоминание');

  // Следующий ответ учитывает факты
  await send(page, 'Посоветуй, что почитать по моей теме');
  const memMeta = await page.$$eval('.msg-assistant .meta-memory', (m) => m.map((x) => ({ text: x.textContent, title: x.title })));
  assert(memMeta.length === 1 && memMeta[0].text === '🧠 3 факта', '«🧠 3 факта» под вторым ответом');
  assert(memMeta[0].title.includes('Зовут Олег'), 'подсказка показывает учтённые факты');
  const req = await lastRequest();
  assert(req.messages[0].content.includes('- Учится на 2 курсе'), 'факты в системном промпте');
  await page.screenshot({ path: OUT + '/m1-chat-memory.png' });

  // Обновление факта и отмена из чата
  await send(page, 'Кстати, теперь я учусь на 3 курсе, перевёлся');
  await page.waitForSelector('.msg-assistant:last-child .memory-note');
  const upd = await page.textContent('.msg-assistant:last-child .memory-note');
  assert(upd.includes('Обновил') && upd.includes('→'), '«✏️ Обновил: … → …»');
  await page.click('.msg-assistant:last-child .memory-note .link-btn');
  await page.waitForSelector('.msg-assistant:last-child .memory-note.undone');
  assert(true, 'обновление отменено из чата');

  // После перезагрузки отметки остаются на своих местах
  await page.reload();
  await page.waitForSelector('.memory-note');
  const afterReload = await page.$$eval('.msg-assistant', (msgs) => msgs.map((m) => m.querySelectorAll('.memory-note').length));
  assert(afterReload.join(',') === '3,0,1', `отметки памяти восстановились под нужными ответами (${afterReload})`);
  assert(await page.$('.msg-assistant:last-child .memory-note.undone') !== null, 'отмена тоже сохранилась');

  // --- Страница «Память» ---
  await page.click('#memory-btn');
  await page.waitForSelector('.fact');
  const facts = await page.$$eval('.fact .fact-text', (f) => f.map((x) => x.textContent));
  assert(facts.includes('Учится на 2 курсе'), 'после отмены — снова «2 курс»');
  assert((await page.textContent('#memory-stats')).includes('3 факта'), 'сводка: 3 факта');
  assert((await page.textContent('.fact-meta')).includes('из диалога'), 'видно, из какого диалога факт');
  await page.screenshot({ path: OUT + '/m2-memory-page.png' });

  // Ручное добавление
  await page.click('#memory-add-btn');
  await page.fill('#memory-add-text', 'готовлюсь к сессии в январе');
  await page.selectOption('#memory-add-category', 'учёба');
  await page.check('#memory-add-pinned');
  await page.click('#memory-add-form button[type=submit]');
  await page.waitForSelector('.memory-group h3:has-text("Закреплённые")');
  assert((await page.textContent('.memory-group:first-child .fact-text')) === 'Готовлюсь к сессии в январе', 'ручной факт закреплён и сверху');

  // Правка
  await page.hover('.fact:has-text("Пишет на javascript")');
  await page.click('.fact:has-text("Пишет на javascript") .icon-btn[title="Изменить"]');
  await page.fill('.fact-edit textarea', 'Пишет на JavaScript и TypeScript');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.fact-text:has-text("Пишет на JavaScript и TypeScript")');
  assert(true, 'правка факта');

  // Поиск (регистр не важен)
  await page.fill('#memory-search', 'TYPESCRIPT');
  await page.waitForFunction(() => document.querySelectorAll('.fact').length === 1);
  assert(true, 'поиск без учёта регистра');
  await page.fill('#memory-search', '');
  await page.waitForFunction(() => document.querySelectorAll('.fact').length === 4);

  // Удаление и отмена через журнал
  await page.hover('.fact:has-text("Зовут Олег")');
  await page.click('.fact:has-text("Зовут Олег") .icon-btn[title="Удалить"]');
  await page.waitForFunction(() => document.querySelectorAll('.fact').length === 3);
  await page.click('#memory-journal summary');
  await page.waitForSelector('.journal-item');
  assert((await page.textContent('.journal-item')).includes('Удалено: «Зовут Олег»'), 'удаление в журнале');
  await page.screenshot({ path: OUT + '/m3-journal.png' });
  await page.click('.journal-item .link-btn');
  await page.waitForFunction(() => document.querySelectorAll('.fact').length === 4);
  assert(true, 'удаление отменено из журнала');

  // Выключатели
  await page.uncheck('#mem-autosave', { force: true });
  await page.waitForTimeout(300);
  await page.click('#new-chat-btn');
  await send(page, 'Меня зовут Вася и я учусь на 4 курсе');
  await page.waitForTimeout(500);
  assert(await page.$('.msg-assistant .memory-note') === null, 'автозапоминание выключено — ничего не запомнено');
  await page.click('#memory-btn');
  await page.uncheck('#mem-enabled', { force: true });
  await page.waitForSelector('#memory-stats .warn');
  assert(await page.isDisabled('#mem-autosave'), 'без памяти автозапоминание недоступно');
  await page.click('#new-chat-btn');
  await send(page, 'Что ты обо мне знаешь?');
  assert(!(await lastRequest()).messages[0].content.includes('Что ты знаешь о пользователе'), 'память выключена — фактов в промпте нет');
  await page.click('#memory-btn');
  await page.check('#mem-enabled', { force: true });
  await page.waitForSelector('#mem-autosave:not([disabled])');
  await page.check('#mem-autosave', { force: true });
  await page.waitForSelector('#memory-stats:not(:has(.warn))');

  // Стереть всё
  page.once('dialog', (d) => d.accept());
  await page.click('#memory-clear');
  await page.waitForSelector('.memory-empty');
  assert(true, 'вся память стёрта');

  // Прямая ссылка #/memory и телефон
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/');
  await mobile.waitForSelector('#conn-status.is-ok');
  await mobile.evaluate(async () => {
    for (const c of ['Зовут Олег', 'Учится на 3 курсе в МГТУ', 'Пишет на JavaScript и Python']) {
      await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: c }) });
    }
  });
  await mobile.goto('http://127.0.0.1:8000/#/memory');
  await mobile.waitForSelector('.fact');
  assert(await mobile.isVisible('#memory-view'), 'ссылка #/memory открывает страницу памяти');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'страница памяти без горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/m4-mobile-memory.png' });

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 3 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
