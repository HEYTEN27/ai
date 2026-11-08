// Сквозная проверка этапа 4: база знаний (RAG).
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
const fakeConfig = (cfg) => fetch(FAKE + '/_test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });

// --- тестовые файлы ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
const NOTE = `---
title: Замыкания в JavaScript
---
# Основы

Замыкание — это функция, которая запоминает переменные из внешней области видимости.

## Счётчик

\`\`\`js
function counter() { let count = 0; return () => ++count; }
\`\`\`

Каждый вызов counter() создаёт новое замыкание со своей переменной count.
`;
fs.writeFileSync(path.join(dir, 'closures.md'), NOTE);
fs.writeFileSync(path.join(dir, 'Список дел.txt'), 'Купить тетради. Сдать лабораторную по физике в пятницу.');

function makePdf(file, pages) { // минимальный PDF с текстом (как в tests/test_knowledge.py)
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(file, out, 'latin1');
}
const filler = 'Introduction to the course and general organisation of lectures and seminars.';
makePdf(path.join(dir, 'event-loop.pdf'), [filler, 'The event loop takes callbacks from the task queue when the call stack is empty.']);

const vault = path.join(dir, 'Obsidian Vault');
fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
fs.writeFileSync(path.join(vault, '.obsidian', 'app.md'), 'служебное');
fs.writeFileSync(path.join(vault, 'Промисы.md'), '# Промисы\n\nПромис — объект, представляющий результат асинхронной операции: pending, fulfilled или rejected.');

async function waitIndexed(page) {
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.kb-doc')];
    return rows.length && rows.every((r) => r.dataset.status === 'ready' || r.dataset.status === 'error');
  }, null, { timeout: 20000 });
}

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
  // «Векторы» эмулятора — подсчёт общих слов, их близость ниже, чем у настоящей bge-m3; понижаем порог
  await fetch(APP + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rag_min_score: 0.15 }) });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 404/409 — ожидаемые ответы сервера в сценарии (повторное подключение папки и т.п.)
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (404|409)/.test(m.text())) errors.push(m.text()); });

  await page.goto(APP + '/');
  await page.waitForSelector('#conn-status.is-ok');
  assert(await page.isHidden('#kb-scope-row'), 'пока база пуста — выбора базы знаний у поля ввода нет');

  // --- Загрузка файлов ---
  await page.click('#knowledge-btn');
  await page.waitForSelector('#knowledge-view:not([hidden])');
  assert(page.url().endsWith('#/knowledge'), 'адрес #/knowledge');
  await page.waitForSelector('#kb-collections .memory-empty');
  await page.setInputFiles('#kb-file-input', ['closures.md', 'Список дел.txt', 'event-loop.pdf'].map((f) => path.join(dir, f)));
  await page.waitForSelector('.kb-doc');
  await waitIndexed(page);
  const docs = await page.$$eval('.kb-doc .d-title', (d) => d.map((x) => x.textContent));
  console.log('  документы:', docs);
  assert(docs.length === 3 && docs.includes('Замыкания в JavaScript'), 'три документа проиндексированы, заголовок из шапки заметки');
  assert((await page.textContent('#kb-stats')).includes('поиск по смыслу: bge-m3'), 'сводка: поиск по смыслу');
  assert((await page.textContent('.kb-doc:has(.d-type.pdf) .d-meta')).includes('2 страницы'), 'у PDF видно число страниц');
  await page.screenshot({ path: OUT + '/k1-knowledge.png' });

  // --- Подключение папки Obsidian ---
  await page.fill('#kb-folder-path', vault);
  await page.click('#kb-folder-form button[type=submit]');
  await page.waitForSelector('.kb-collection:has-text("Obsidian Vault")');
  await waitIndexed(page);
  assert((await page.$$('.kb-collection:has-text("Obsidian Vault") .kb-doc')).length === 1, 'папка подключена, .obsidian пропущена');
  fs.writeFileSync(path.join(vault, 'Async.md'), '# Async/await\n\nasync/await — удобная запись работы с промисами.');
  await page.click('.kb-collection:has-text("Obsidian Vault") button:has-text("Синхронизировать")');
  await page.waitForFunction(() => document.querySelectorAll('.kb-collection:nth-child(2) .kb-doc').length === 2, null, { timeout: 10000 });
  await waitIndexed(page);
  assert(true, 'синхронизация нашла новую заметку');
  await page.fill('#kb-folder-path', vault);
  await page.click('#kb-folder-form button[type=submit]');
  await page.waitForSelector('#kb-folder-error:not([hidden])');
  assert((await page.textContent('#kb-folder-error')).includes('уже подключена'), 'повторное подключение папки — понятная ошибка');

  // --- Проверка поиска ---
  await page.click('#kb-search-box summary');
  await page.fill('#kb-search-input', 'как работает event loop и task queue');
  await page.click('#kb-search-form button');
  await page.waitForSelector('.kb-hit');
  assert((await page.textContent('.kb-hit-head')).includes('event-loop'), 'проверка поиска показывает найденный фрагмент');

  // --- Ответ со ссылками ---
  await page.click('#new-chat-btn');
  await page.waitForSelector('#kb-scope-row:not([hidden])');
  const scopes = await page.$$eval('#kb-scope option', (o) => o.map((x) => x.textContent));
  assert(scopes[0] === 'Искать в базе знаний' && scopes.includes('Только «Obsidian Vault»') && scopes.at(-1) === 'Без базы знаний', 'выбор базы знаний у поля ввода');
  await send(page, 'Объясни, что такое замыкание и как работает счётчик');
  const cites = await page.$$eval('.msg-assistant .cite', (c) => c.map((x) => x.textContent));
  assert(cites.length >= 1 && cites[0] === '1', `ссылки [n] стали кнопками (${cites})`);
  const text = await page.textContent('.msg-assistant .content');
  assert(/\[\d+\] должна остаться текстом/.test(text), 'выдуманный номер источника остался обычным текстом');
  const chips = await page.$$eval('.msg-assistant .source-chip', (c) => c.map((x) => x.textContent));
  assert(chips[0].includes('Замыкания в JavaScript'), 'список источников под ответом');
  const req = await lastRequest();
  assert(req.messages.at(-1).content.startsWith('Фрагменты из базы знаний'), 'фрагменты ушли в модель');

  await page.click('.msg-assistant .cite >> nth=0');
  await page.waitForSelector('#source-dialog[open]');
  await page.waitForFunction(() => document.querySelector('#source-text').textContent !== 'Загружаю…');
  assert((await page.textContent('#source-text')).includes('замыкание'), 'окно источника показывает фрагмент');
  assert((await page.getAttribute('#source-open', 'href')).includes('/api/knowledge/documents/'), 'кнопка «Открыть документ»');
  await page.screenshot({ path: OUT + '/k2-source.png' });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: OUT + '/k3-chat-citations.png' });

  // PDF: ссылка открывает нужную страницу
  await send(page, 'Как event loop берёт callbacks из task queue?');
  await page.click('.msg-assistant:last-child .source-chip:has-text("event-loop")');
  await page.waitForSelector('#source-dialog[open]');
  assert((await page.getAttribute('#source-open', 'href')).includes('#page='), 'PDF открывается на нужной странице (#page=)');
  const fileResp = await page.request.get(APP + (await page.getAttribute('#source-open', 'href')).split('#')[0]);
  assert(fileResp.headers()['content-type'] === 'application/pdf', 'оригинал PDF отдаётся браузеру');
  await page.keyboard.press('Escape');

  // После перезагрузки ссылки сохраняются
  await page.reload();
  await page.waitForSelector('.msg-assistant .cite');
  assert((await page.$$('.msg-assistant .source-chip')).length >= 2, 'источники восстановились после перезагрузки');

  // Без базы знаний
  await page.selectOption('#kb-scope', 'off');
  await page.waitForTimeout(200);
  await send(page, 'Объясни замыкание и счётчик ещё раз');
  assert(await page.$('.msg-assistant:last-child .sources') === null, '«Без базы знаний» — источников нет');
  assert(!(await lastRequest()).messages.at(-1).content.includes('Фрагменты'), 'и в модель фрагменты не ушли');
  await page.reload();
  await page.waitForSelector('.msg-assistant');
  assert(await page.inputValue('#kb-scope') === 'off', 'выбор базы знаний запомнился в диалоге');

  // --- Нет модели эмбеддингов → работает по словам, потом «Досчитать векторы» ---
  await fakeConfig({ embed_available: false });
  await page.click('#knowledge-btn');
  fs.writeFileSync(path.join(dir, 'Физика.md'), '# Лабораторная\n\nЛабораторная работа по физике: маятник и период колебаний.');
  await page.setInputFiles('#kb-file-input', [path.join(dir, 'Физика.md')]);
  await page.waitForSelector('.kb-doc:has-text("Физика") .d-meta.warn', { timeout: 20000 });
  assert((await page.textContent('.kb-doc:has-text("Физика") .d-meta.warn')).includes('ollama pull bge-m3'), 'предупреждение: нет модели эмбеддингов');
  await fakeConfig({ embed_available: true });
  await page.reload();
  await page.waitForSelector('#kb-stats .link-btn');
  await page.click('#kb-stats .link-btn');
  await page.waitForFunction(() => !document.querySelector('.kb-doc .d-meta.warn'), null, { timeout: 20000 });
  assert(true, '«Досчитать векторы» убрал предупреждение');

  // --- Удаление ---
  page.once('dialog', (d) => d.accept());
  await page.hover('.kb-doc:has-text("Список дел")');
  await page.click('.kb-doc:has-text("Список дел") .icon-btn[title="Удалить из базы знаний"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('.kb-doc')].some((d) => d.textContent.includes('Список дел')));
  assert(true, 'документ удалён');
  page.once('dialog', (d) => d.accept());
  await page.click('.kb-collection:has-text("Obsidian Vault") .btn-danger-text');
  await page.waitForFunction(() => !document.querySelector('.kb-collection:nth-child(2)'));
  assert(fs.existsSync(path.join(vault, 'Промисы.md')), 'удаление коллекции-папки не трогает файлы на диске');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(APP + '/#/knowledge');
  await mobile.waitForSelector('.kb-doc');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'страница базы знаний без горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/k4-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 4 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
