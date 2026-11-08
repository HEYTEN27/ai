// Сквозная проверка этапа 15а: проекты (инструкции, файлы, чаты), стиль ответов,
// правка своего вопроса с ветками «‹ 1/2 ›», поиск Ctrl+K с переходом к сообщению.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();

async function waitAnswer(page, before) {
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 20000 });
}

async function send(page, text) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await waitAnswer(page, before);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Проект: создание, инструкции, файл ---
  await page.click('#projects-btn');
  await page.fill('#project-new-icon', '🗄️');
  await page.fill('#project-new-name', 'Курсовая по БД');
  await page.click('#project-new-form button[type=submit]');
  await page.waitForSelector('#project-detail:not([hidden])');
  assert(await page.inputValue('#project-name') === 'Курсовая по БД', 'проект создан и открыт');
  await page.fill('#project-instructions', 'Примеры пиши на PostgreSQL.');
  await page.click('#project-save');
  await page.waitForFunction(() => document.getElementById('project-saved').textContent.includes('Сохранено'));
  await page.setInputFiles('#project-file-input', { name: 'задание.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Тема курсовой: учёт книг в библиотеке.') });
  await page.waitForSelector('.project-file');
  assert((await page.textContent('.project-file a')).includes('задание.txt'), 'файл в проекте');
  await page.screenshot({ path: OUT + '/pr1-project.png' });

  // --- Новый чат в проекте + стиль ---
  await page.click('#project-new-chat');
  await page.waitForSelector('#project-chip:not([hidden])');
  assert((await page.textContent('#project-chip')).includes('Курсовая по БД'), 'над полем ввода — значок проекта');
  await page.selectOption('#style-select', 'concise');
  await send(page, 'Какая тема проекта?');
  let req = await lastRequest();
  assert(req.messages[0].content.includes('PostgreSQL') && req.messages[0].content.includes('КРАТКО'),
    'в инструкции модели — проект и стиль «Кратко»');
  assert(req.messages.at(-1).content.includes('учёт книг в библиотеке'), 'файл проекта в контексте');
  assert((await page.textContent('.conv-item.active .conv-title')).startsWith('🗄️'), 'в списке чатов — значок проекта');

  // --- Правка вопроса → ветка ---
  await send(page, 'Сколько глав нужно?');
  await page.hover('.msg-user:nth-last-child(2)');
  await page.click('.msg-user:nth-last-child(2) .btn-edit-q');
  await page.fill('.edit-box textarea', 'Сколько страниц нужно?');
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.branch-nav', { timeout: 20000 });
  assert((await page.textContent('.branch-nav .branch-count')) === '2/2', 'после правки — «‹ 2/2 ›»');
  assert((await page.textContent('.msg-user:nth-last-child(2) .bubble')) === 'Сколько страниц нужно?', 'показан новый вариант');
  req = await lastRequest();
  assert(!req.messages.some((m) => m.content.includes('глав')), 'старая ветка в модель не ушла');
  assert(before >= 2, 'ответы на месте');
  await page.screenshot({ path: OUT + '/pr2-branch.png' });
  await page.click('.branch-nav .icon-btn:first-child');
  await page.waitForFunction(() => document.querySelector('.branch-nav .branch-count')?.textContent === '1/2');
  assert((await page.textContent('.msg-user:nth-last-child(2) .bubble')) === 'Сколько глав нужно?', '‹ — старая версия вопроса');
  assert((await page.textContent('.msg-assistant:last-child .content')).includes('Сколько глав'), 'и её ответ');
  await page.click('.branch-nav .icon-btn:last-child');
  await page.waitForFunction(() => document.querySelector('.branch-nav .branch-count')?.textContent === '2/2');

  // --- Поиск Ctrl+K: находит и в неактивной ветке ---
  await page.click('#new-chat-btn');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#search-dialog[open]');
  await page.fill('#search-input', 'глав');
  await page.waitForSelector('.search-item .si-snippet mark');
  assert((await page.textContent('.search-item .si-snippet mark')).toLowerCase().startsWith('глав'), 'совпадение подсвечено');
  await page.screenshot({ path: OUT + '/pr3-search.png' });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.is-found');
  assert((await page.textContent('.branch-nav .branch-count')) === '1/2', 'переход в ветку, где найдено сообщение');
  assert((await page.textContent('.msg.is-found .bubble, .msg-assistant.is-found .content')).includes('глав'), 'найденное сообщение подсвечено');

  // --- Значок проекта ведёт в проект; удаление проекта не удаляет чат ---
  await page.click('#project-chip');
  await page.waitForSelector('#project-detail:not([hidden]) .project-chat');
  assert(await page.$$eval('.project-chat', (c) => c.length) === 1, 'в проекте один чат');
  page.once('dialog', (d) => d.accept());
  await page.click('#project-delete');
  await page.waitForSelector('#projects-list-view:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('.conv-item .conv-title')?.textContent.startsWith('🗄️'));
  assert(await page.$$eval('.conv-item', (c) => c.length) === 1, 'чат остался, но уже без проекта');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/');
  await mobile.waitForSelector('#conn-status.is-ok');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 15а ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
