// Сквозная проверка этапа 5: инструменты и подтверждения.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const APP = 'http://127.0.0.1:8000';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();

// Папка, к которой дадим доступ
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-e2e-'));
fs.mkdirSync(path.join(dir, 'Учёба'));
fs.writeFileSync(path.join(dir, 'Учёба', 'план.md'), '# План\n\n1. Повторить замыкания\n2. Сдать лабу по физике');
fs.writeFileSync(path.join(dir, 'секрет.txt'), 'не показывать');

const lastMsg = '.msg-assistant:last-child';

async function send(page, text, { waitDone = true } = {}) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.msg-assistant').length > n, before);
  if (waitDone) await page.waitForSelector(`${lastMsg} .msg-meta:not([hidden])`, { timeout: 20000 });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 422 — ожидаемый ответ на проверку несуществующей папки
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 422/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => { errors.push('alert: ' + d.message()); d.dismiss(); });

  await page.goto(APP + '/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Калькулятор: без подтверждения ---
  await send(page, 'Посчитай (2+3)^2 / sqrt(16)');
  const calc = await page.textContent(`${lastMsg} .tool-card .t-summary`);
  assert(calc === '(2+3)^2 / sqrt(16) = 6.25', `карточка калькулятора: ${calc}`);
  assert(await page.isVisible(`${lastMsg} .tool-card.st-ok`), 'статус «готово»');
  assert((await page.textContent(`${lastMsg} .content`)).includes('6.25'), 'ответ использует результат');

  // --- Python: подтверждение с показом кода ---
  await send(page, 'Запусти код:\n```python\nprint(sum(range(101)))\n```', { waitDone: false });
  await page.waitForSelector(`${lastMsg} .tool-card.st-waiting`);
  assert((await page.textContent(`${lastMsg} .tool-confirm p`)) === 'Запустить этот код в песочнице?', 'карточка спрашивает разрешение');
  assert((await page.textContent(`${lastMsg} .tool-confirm code`)).includes('print(sum(range(101)))'), 'в карточке виден код');
  assert(await page.isVisible('#send-btn.is-stop'), 'пока ждём решения — генерация на паузе (кнопка «Стоп»)');
  await page.screenshot({ path: OUT + '/t1-confirm.png' });
  await page.click(`${lastMsg} .tool-confirm .btn-primary`);
  await page.waitForSelector(`${lastMsg} .msg-meta:not([hidden])`, { timeout: 20000 });
  await page.click(`${lastMsg} .tool-body summary`);
  assert((await page.textContent(`${lastMsg} .tool-body pre.t-out`)).trim() === '5050', 'вывод кода в карточке');
  assert((await page.textContent(`${lastMsg} .content`)).includes('5050'), 'ответ использует вывод');
  await page.screenshot({ path: OUT + '/t2-python.png' });

  // Отказ
  await send(page, 'Запусти код:\n```python\nprint("не надо")\n```', { waitDone: false });
  await page.waitForSelector(`${lastMsg} .tool-card.st-waiting`);
  await page.click(`${lastMsg} .tool-confirm .btn:not(.btn-primary)`);
  await page.waitForSelector(`${lastMsg} .msg-meta:not([hidden])`, { timeout: 20000 });
  assert(await page.isVisible(`${lastMsg} .tool-card.st-declined`), 'отклонённый запуск помечен');
  assert((await lastRequest()).messages.at(-1).content === 'Пользователь отклонил это действие.', 'модель узнала об отказе');

  // «Стоп» во время ожидания решения
  await send(page, 'Запусти код:\n```python\nprint(1)\n```', { waitDone: false });
  await page.waitForSelector(`${lastMsg} .tool-card.st-waiting`);
  await page.click('#send-btn');
  await page.waitForSelector(`${lastMsg} .tool-card .t-status:has-text("остановлено")`);
  assert(await page.$(`${lastMsg} .tool-confirm`) === null, '«Стоп» убирает кнопки подтверждения');

  // --- Настройки → Инструменты: папка для файлов ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=tools]');
  await page.waitForSelector('#tools-form:not([hidden])');
  await page.waitForSelector('#t-confirm-python:checked'); // значения приходят с сервера чуть позже формы
  assert(await page.isChecked('#t-confirm-python') && !(await page.isChecked('#t-confirm-web')), 'по умолчанию: код — с подтверждением, поиск — без');
  await page.fill('#t-root', path.join(dir, 'нет такой'));
  await page.click('#t-root-check');
  await page.waitForSelector('#t-root-status.bad');
  await page.fill('#t-root', dir);
  await page.click('#t-root-check');
  await page.waitForSelector('#t-root-status.ok');
  assert((await page.textContent('#t-root-status')).includes('2 файлов'), 'проверка папки нашла 2 файла');
  await page.selectOption('#t-provider', 'searxng');
  await page.fill('#t-searxng', FAKE + '/searxng');
  await page.screenshot({ path: OUT + '/t3-settings.png' });
  await page.click('#tools-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });

  // Чтение файла — всегда с подтверждением
  await page.click('#new-chat-btn');
  await send(page, 'Прочитай файл Учёба/план.md', { waitDone: false });
  await page.waitForSelector(`${lastMsg} .tool-card.st-waiting`);
  assert((await page.textContent(`${lastMsg} .tool-confirm p`)) === 'Прочитать файл «Учёба/план.md» из вашей папки?', 'вопрос о чтении файла');
  await page.click(`${lastMsg} .tool-confirm .btn-primary`);
  await page.waitForSelector(`${lastMsg} .msg-meta:not([hidden])`, { timeout: 20000 });
  await page.click(`${lastMsg} .tool-body summary`);
  assert((await page.textContent(`${lastMsg} .tool-body pre`)).includes('Повторить замыкания'), 'содержимое файла в карточке');

  await send(page, 'Покажи файлы в моей папке', { waitDone: false });
  await page.waitForSelector(`${lastMsg} .tool-card.st-waiting`);
  await page.click(`${lastMsg} .tool-confirm .btn:not(.btn-primary)`);
  await page.waitForSelector(`${lastMsg} .tool-card.st-declined`);
  await page.waitForSelector(`${lastMsg} .msg-meta:not([hidden])`, { timeout: 20000 });
  assert(!JSON.stringify(await lastRequest()).includes('секрет.txt'), 'после отказа список файлов модели не передан');

  // --- Поиск в интернете (через поддельный SearXNG) ---
  await send(page, 'Найди в интернете курс доллара');
  await page.click(`${lastMsg} .tool-body summary`);
  const links = await page.$$eval(`${lastMsg} .t-results a`, (a) => a.map((x) => ({ text: x.textContent, href: x.href, target: x.target })));
  assert(links.length === 2 && links[0].text === 'Результат про курс доллара' && links[0].target === '_blank', 'результаты поиска со ссылками');
  await page.screenshot({ path: OUT + '/t4-search.png' });

  // --- После перезагрузки карточки на месте ---
  await page.reload();
  await page.waitForSelector('.tool-card');
  const statuses = await page.$$eval('.tool-card', (c) => c.map((x) => x.dataset.status));
  assert(statuses.join(',') === 'ok,declined,ok', `карточки восстановились (${statuses})`);

  // --- Инструменты выключены ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=tools]');
  await page.waitForSelector('#tools-form:not([hidden])');
  await page.uncheck('#t-enabled', { force: true });
  assert(await page.isVisible('#tools-form.tools-disabled'), 'без главного выключателя остальное неактивно');
  await page.click('#tools-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  await send(page, 'Посчитай 2+2');
  assert(await page.$(`${lastMsg} .tool-card`) === null, 'инструменты выключены — карточек нет');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(page.url());
  await mobile.waitForSelector('.tool-card');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'карточки инструментов без горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/t5-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 5 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
