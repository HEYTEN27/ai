// Сквозная проверка этапа 11: уроки из 👎 и исправлений, раздел «Уроки», авто-размышления,
// «▶ Проверить» для Python и JavaScript с кнопкой «Исправить».
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();
const last = '.msg-assistant:last-child';

async function send(page, text) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await waitAnswer(page, before);
}

async function waitAnswer(page, before) {
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 20000 });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.startsWith('about:srcdoc')) errors.push(m.text());
  });
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- 👎 с причиной → урок ---
  await send(page, 'Напиши функцию сложения');
  await page.click(`${last} .btn-dislike`);
  await page.waitForSelector(`${last} .why-box`);
  assert(await page.$$eval(`${last} .why-chip`, (c) => c.length) === 5, 'после 👎 — «Что не так?» с причинами');
  await page.click(`${last} .why-chip[data-key=long]`);
  await page.click(`${last} .why-box .btn-send`);
  await page.waitForSelector(`${last} .lesson-note:not(.is-pending)`);
  assert((await page.textContent(`${last} .lesson-note`)).includes('Урок: «Отвечай короче'), 'урок из причины «Слишком длинно»');
  await page.screenshot({ path: OUT + '/l1-dislike.png' });

  // --- Исправление → урок, отмена ---
  await page.click(`${last} .btn-edit`);
  await page.fill(`${last} .correct-box textarea`, 'function add(a: number, b: number): number { return a + b } — на TypeScript');
  await page.click(`${last} .correct-box .btn-save`);
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant:last-child .lesson-note')]
    .some((n) => n.textContent.includes('TypeScript')));
  assert(true, 'исправление → урок «Код пиши на TypeScript»');
  const tsNote = page.locator(`${last} .lesson-note`, { hasText: 'TypeScript' });
  await tsNote.locator('button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant:last-child .lesson-note')]
    .some((n) => n.textContent.includes('Урок отменён')));
  assert(true, '«Отменить» убирает урок');
  // Исправим ещё раз — урок вернётся
  await page.click(`${last} .btn-edit`);
  await page.fill(`${last} .correct-box textarea`, 'Переписал на TypeScript');
  await page.click(`${last} .correct-box .btn-save`);
  await page.waitForFunction(() => document.querySelectorAll('.msg-assistant:last-child .lesson-note').length === 3);

  // --- Уроки уходят в инструкцию модели ---
  await send(page, 'Ещё функцию умножения');
  const system = (await lastRequest()).messages[0].content;
  assert(system.includes('- Код пиши на TypeScript') && system.includes('- Отвечай короче'), 'уроки в системном промпте');

  // --- Раздел «Уроки» на странице «Память» ---
  await page.click('#memory-btn');
  await page.waitForSelector('.lesson-item');
  const texts = await page.$$eval('.lesson-item .lesson-text', (t) => t.map((x) => x.textContent));
  assert(texts.length === 2 && texts[0] === 'Код пиши на TypeScript', 'уроки на странице «Память», свежие сверху');
  assert((await page.textContent('.lesson-item .lesson-meta')).startsWith('из исправления'), 'видно, откуда урок');
  await page.fill('#lesson-add-text', 'Примеры — из веб-разработки');
  await page.click('#lesson-add-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.lesson-item').length === 3);
  assert(true, 'урок можно добавить вручную');
  await page.uncheck('.lesson-item:has-text("Отвечай короче") input[type=checkbox]');
  await page.waitForSelector('.lesson-item.is-off');
  assert(true, 'урок можно выключить');
  await page.click('.lesson-item:has-text("Примеры") .link-btn:has-text("Изменить")');
  await page.fill('.lesson-edit', 'Примеры — из фронтенда');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.lesson-item:has-text("Примеры — из фронтенда")');
  assert(true, 'урок можно изменить');
  await page.screenshot({ path: OUT + '/l2-lessons.png', fullPage: true });
  await page.click('.lesson-item:has-text("фронтенда") .link-btn.danger');
  await page.waitForFunction(() => document.querySelectorAll('.lesson-item').length === 2);
  assert(true, 'урок можно удалить');
  await page.click('#new-chat-btn');
  await send(page, 'Привет');
  const system2 = (await lastRequest()).messages[0].content;
  assert(!system2.includes('Отвечай короче') && system2.includes('TypeScript'), 'выключенный урок не применяется');

  // --- Авто-размышления ---
  await send(page, 'Докажи теорему Пифагора');
  assert((await page.textContent(`${last} .thinking summary`)).includes('включились сами: математика'), 'сложный вопрос — размышления сами');
  await send(page, 'Спасибо, отлично!');
  assert(await page.isHidden(`${last} .thinking`), 'простой — без размышлений');

  // --- «▶ Проверить» Python → ошибка → «Исправить» → работает ---
  await send(page, 'Покажи код с ошибкой');
  await page.click(`${last} .run-btn`);
  await page.waitForSelector(`${last} .run-output.is-error`);
  assert((await page.textContent(`${last} .run-output .run-err`)).includes('ZeroDivisionError'), 'Python запущен в песочнице: видна ошибка');
  await page.screenshot({ path: OUT + '/l3-run-error.png' });
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.click(`${last} .run-output .fix-btn`);
  await waitAnswer(page, before);
  assert((await page.textContent('.msg-user:nth-last-child(2) .bubble')).includes('ZeroDivisionError'), '«Исправить» отправил текст ошибки');
  await page.click(`${last} .run-btn`);
  await page.waitForSelector(`${last} .run-output.is-ok`);
  assert((await page.textContent(`${last} .run-output pre`)).trim() === '2.0', 'исправленный код работает');

  // --- JavaScript в песочнице браузера ---
  await send(page, 'Дай пример на js');
  await page.click(`${last} .run-btn`);
  await page.waitForSelector(`${last} .run-output.is-ok`);
  assert((await page.textContent(`${last} .run-output pre`)) === '[2,4,6]\nготово', 'JS: console.log и таймеры');
  assert(await page.$('iframe.run-frame') === null, 'песочница JS убрана после запуска');

  // --- Настройки ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=tools]');
  await page.waitForSelector('#t-auto-think:checked');
  assert(!(await page.isChecked('#t-auto-check')), 'автопроверка кода по умолчанию выключена');
  await page.keyboard.press('Escape');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/#/memory');
  await mobile.waitForSelector('.lesson-item');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 11 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
