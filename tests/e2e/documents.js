// Сквозная проверка этапа 9: вложения в чате, создание Word / PowerPoint / Excel, правка Word.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8000';
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();

async function waitAnswer(page, before) {
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 15000 });
}

async function send(page, text) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await waitAnswer(page, before);
}

const last = '.msg-assistant:last-child';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // 415/422 при загрузке картинки — ожидаемый ответ сервера, браузер пишет его в консоль
    if (m.type() === 'error' && !/status of 41[35]|status of 422/.test(m.text())) errors.push(m.text());
  });

  await page.goto(BASE + '/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- «Скачать как Word» под обычным ответом ---
  await send(page, 'Привет');
  const wordHref = await page.getAttribute(`${last} .btn-word`, 'href');
  assert(wordHref && await page.isVisible(`${last} .btn-word`), 'под ответом есть кнопка «Скачать как Word»');
  const wordResp = await fetch(BASE + wordHref);
  const answerDocx = Buffer.from(await wordResp.arrayBuffer());
  assert(answerDocx.subarray(0, 2).toString() === 'PK' && /filename\*=UTF-8''/i.test(wordResp.headers.get('content-disposition')),
    'ответ скачивается как .docx с русским именем');

  // --- Прикрепить файлы: текст и картинку (картинку пока нельзя) ---
  await page.setInputFiles('#attach-input', [
    { name: 'лекция.txt', mimeType: 'text/plain', buffer: Buffer.from('Фотосинтез происходит в хлоропластах.\n\nВторой абзац лекции.') },
    { name: 'фото.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  await page.waitForSelector('.attach-chip.is-ready');
  await page.waitForSelector('.attach-chip.is-error');
  assert((await page.textContent('.attach-chip.is-ready .a-info')).includes('символ'), 'чип файла: размер и число символов');
  assert((await page.textContent('.attach-chip.is-error .a-info')).includes('Картинки'), 'картинка — понятная ошибка');
  await page.click('.attach-chip.is-error .a-remove');
  assert(await page.$$eval('.attach-chip', (c) => c.length) === 1, 'ошибочный чип можно убрать');
  assert(await page.isEnabled('#send-btn'), 'можно отправить только файл, без текста');
  await page.screenshot({ path: OUT + '/d1-attach.png' });

  // Отправка без текста — вопрос подставляется сам
  let before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.click('#send-btn');
  await waitAnswer(page, before);
  assert(await page.isHidden('#attach-list'), 'после отправки чипы ушли из поля ввода');
  assert((await page.textContent('.msg-user:nth-last-child(2) .file-chip .f-name')) === 'лекция.txt', 'файл виден в сообщении');
  assert((await page.textContent('.msg-user:nth-last-child(2) .bubble')).startsWith('Посмотри прикреплённые файлы'), 'вопрос по умолчанию');
  assert((await page.textContent(`${last} .content`)).includes('Прочитал файлы: «лекция.txt»'), 'модель получила текст файла');
  assert((await page.textContent(`${last} .meta-files`)).includes('📎 1 файл'), 'под ответом: сколько файлов прочитано');

  // --- Правка прикреплённого Word с сохранением оформления ---
  await page.setInputFiles('#attach-input', { name: 'Курсовая.docx', buffer: answerDocx,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  await page.waitForSelector('.attach-chip.is-ready');
  await send(page, 'Замени «тестовый» на «проверочный» в Курсовая.docx');
  await page.waitForSelector(`${last} .doc-card`);
  assert((await page.textContent(`${last} .doc-name`)) === 'Курсовая (исправлено).docx', 'исправленная копия');
  assert((await page.textContent(`${last} .doc-changes ins`)) === 'проверочный', 'карточка показывает замены');

  // --- Создать Word ---
  await send(page, 'Сделай реферат в Word про замыкания');
  await page.waitForSelector(`${last} .doc-card .doc-page h1`);
  assert((await page.textContent(`${last} .doc-page h1`)) === 'Реферат: замыкания', 'предпросмотр документа «как на бумаге»');
  assert(await page.$(`${last} .doc-page table`) !== null, 'таблица в предпросмотре');
  const docUrl = await page.getAttribute(`${last} .doc-download`, 'href');
  const docBytes = Buffer.from(await (await fetch(BASE + docUrl)).arrayBuffer());
  assert(docBytes.subarray(0, 2).toString() === 'PK', 'кнопка «Скачать» отдаёт .docx');
  assert((await page.textContent(`${last} .tool-head .t-summary`)) === 'Реферат замыкания', 'в заголовке карточки — имя файла');
  await page.screenshot({ path: OUT + '/d2-word.png' });

  // --- Презентация и таблица ---
  await send(page, 'Сделай презентацию про замыкания');
  await page.click(`${last} .doc-preview summary`);
  assert(await page.$$eval(`${last} .slide-thumb`, (s) => s.length) === 3, 'миниатюры: титульный + 2 слайда');
  assert(await page.$(`${last} .slide-thumb li.sub`) !== null, 'подпункты на миниатюре');
  await page.screenshot({ path: OUT + '/d3-slides.png' });

  await send(page, 'Составь таблицу Excel с бюджетом');
  await page.click(`${last} .doc-preview summary`);
  assert((await page.textContent(`${last} .sheet-preview th`)) === 'Статья', 'шапка таблицы в предпросмотре');
  assert(await page.$(`${last} .sheet-preview td.num`) !== null, 'числа выровнены как числа');
  await page.screenshot({ path: OUT + '/d4-excel.png' });

  // --- После перезагрузки всё на месте ---
  await page.reload();
  await page.waitForSelector('.doc-card');
  assert(await page.$$eval('.doc-card', (c) => c.length) === 4, 'карточки документов восстановились');
  assert(await page.$$eval('.msg-user .file-chip', (c) => c.length) === 2, 'вложения в сообщениях восстановились');

  // Созданный документ модель видит в следующем вопросе
  await send(page, 'Что в реферате?');
  const req = await lastRequest();
  assert(req.messages.at(-1).content.includes('Реферат замыкания.docx» (создан тобой ранее'), 'созданный документ в контексте');

  // --- Перетаскивание файла в окно ---
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['перетащенный текст'], 'заметка.md', { type: 'text/markdown' }));
    const main = document.querySelector('.main');
    main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    window.__overlay = !document.getElementById('drop-overlay').hidden;
    main.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    main.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  assert(await page.evaluate(() => window.__overlay), 'при перетаскивании видна подсказка');
  await page.waitForSelector('.attach-chip.is-ready[data-name="заметка.md"]');
  assert(await page.isHidden('#drop-overlay'), 'подсказка исчезла после броска');
  // Неотправленное вложение убираем — оно удаляется и на сервере
  await page.click('.attach-chip .a-remove');
  assert(await page.isHidden('#attach-list'), 'вложение убрано');

  // --- Настройка инструмента ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=tools]');
  await page.waitForSelector('#t-documents:checked');
  assert(true, 'в настройках есть переключатель «Документы»');
  await page.keyboard.press('Escape');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(page.url());
  await mobile.waitForSelector('.doc-card');
  await mobile.setInputFiles('#attach-input', { name: 'очень-длинное-имя-файла-с-конспектом-лекции.txt', mimeType: 'text/plain', buffer: Buffer.from('текст') });
  await mobile.waitForSelector('.attach-chip.is-ready');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');
  await mobile.evaluate(() => document.querySelector('.doc-card').scrollIntoView());
  await mobile.screenshot({ path: OUT + '/d5-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 9 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
