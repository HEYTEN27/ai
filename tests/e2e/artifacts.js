// Сквозная проверка этапа 10: артефакты — игры в песочнице, версии, ошибки → «Исправить»,
// локальные библиотеки, блокировка сети, схемы Mermaid и рисунки SVG.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const last = '.msg-assistant:last-child';

async function send(page, text, { duringStream } = {}) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  if (duringStream) await duringStream();
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 30000 });
}

/** iframe артефакта (песочница) — Playwright видит его, хотя у страницы «чужой» источник. */
async function artifactFrame(page) {
  const handle = await page.waitForSelector('#ap-view iframe');
  const frame = await handle.contentFrame();
  await frame.waitForLoadState();
  return frame;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss(); });
  // undefinedFunction — намеренная ошибка в игре из сценария (Playwright сообщает и об ошибках во фреймах)
  page.on('pageerror', (e) => { if (!e.message.includes('undefinedFunction')) errors.push(e.message); });
  page.on('console', (m) => {
    // Ошибки ВНУТРИ артефакта (about:srcdoc) — часть сценария, их ловит сама панель
    if (m.type() === 'error' && !m.location().url.startsWith('about:srcdoc')) errors.push(m.text());
  });

  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Игра: карточка «пишу код…» во время ответа, затем автозапуск в панели ---
  let sawWriting = false;
  await send(page, 'Сделай игру змейка', {
    duringStream: async () => {
      await page.waitForSelector('.artifact-card.is-writing', { timeout: 10000 });
      sawWriting = (await page.textContent('.artifact-card.is-writing .ac-sub')).startsWith('пишу код');
    },
  });
  assert(sawWriting, 'пока модель пишет код — карточка «пишу код… N строк»');
  assert(await page.$(`${last} pre code.language-html`) === null, 'вместо простыни кода — карточка');
  assert((await page.textContent(`${last} .ac-title`)) === 'Змейка', 'название из <title>');
  await page.waitForSelector('#artifact-panel:not([hidden])');
  assert(await page.isVisible('.artifact-card.is-open'), 'игра сама открылась в панели');
  let frame = await artifactFrame(page);
  await frame.waitForFunction(() => window.gameReady === true);
  assert(await page.getAttribute('#ap-view iframe', 'sandbox') === 'allow-scripts allow-pointer-lock allow-modals',
    'песочница без allow-same-origin');
  await page.click('#ap-view iframe');
  await page.keyboard.press('ArrowRight');
  await frame.waitForFunction(() => document.getElementById('score').textContent === 'Счёт: 20');
  assert(true, 'игра управляется с клавиатуры');
  await page.screenshot({ path: OUT + '/a1-game.png' });

  await page.click('#ap-tabs [data-tab=code]');
  assert((await page.textContent('#ap-code-body')).includes('<canvas'), 'вкладка «Код»');
  assert(await page.$('#ap-code-body .hljs-tag') !== null, 'код подсвечен');
  await page.click('#ap-tabs [data-tab=view]');

  // --- Ошибка в игре → «Исправить» → новая версия ---
  await send(page, 'Сделай игру с ошибкой');
  await page.waitForSelector('#ap-bars .fix-bar.is-error');
  const errText = await page.textContent('#ap-bars .fix-bar.is-error span');
  const code = await page.evaluate(() => document.querySelector('.msg-assistant:last-child .artifact-card').artifact.code);
  const expectedLine = code.split('\n').findIndex((l) => l.includes('undefinedFunction')) + 1;
  assert(errText.includes('undefinedFunction') && errText.includes(`(строка ${expectedLine})`),
    `ошибка из песочницы с номером строки кода модели: ${errText}`);
  assert(await page.isVisible('#ap-version') && await page.$$eval('#ap-version option', (o) => o.length) === 2,
    'одинаковое название — версии одного артефакта');
  await page.screenshot({ path: OUT + '/a2-error.png' });
  const before = await page.$$eval('.msg-user', (m) => m.length);
  await page.click('#ap-bars .fix-btn');
  await page.waitForFunction((n) => document.querySelectorAll('.msg-user').length > n, before);
  const fixMsg = await page.textContent('.msg-user:nth-last-child(2) .bubble');
  assert(fixMsg.startsWith('В «Змейка» (версия 2) ошибка: ') && fixMsg.includes('исправь'), 'кнопка «Исправить» отправила описание ошибки');
  await page.waitForFunction(() => document.querySelectorAll('#ap-version option').length === 3, null, { timeout: 30000 });
  frame = await artifactFrame(page);
  await frame.waitForFunction(() => window.gameReady === true);
  await page.waitForTimeout(300);
  assert(await page.$('#ap-bars .fix-bar.is-error') === null, 'версия 3 без ошибок');

  await page.selectOption('#ap-version', '0');
  await page.waitForTimeout(200);
  assert(await page.$eval('.artifact-card.is-open', (c) => c.closest('.msg-assistant') === document.querySelectorAll('.msg-assistant')[0]),
    'переключение на версию 1 подсвечивает её карточку в чате');

  // --- 3D: CDN-ссылка на Three.js заменяется локальной копией ---
  await send(page, 'Сделай 3d сцену');
  frame = await artifactFrame(page);
  await frame.waitForFunction(() => window.threeOk === true);
  assert((await frame.title()) === 'Куб 149', 'Three.js подключён локально (без интернета)');
  assert(await page.$('#ap-bars .fix-bar') === null, 'никаких предупреждений');

  // --- Сеть из артефакта заблокирована ---
  await send(page, 'Проверь в сеть');
  frame = await artifactFrame(page);
  await frame.waitForFunction(() => window.netOk === 'blocked');
  assert(true, 'запрос из песочницы к серверу приложения заблокирован');
  await page.waitForSelector('#ap-bars .fix-bar.is-warn');
  assert((await page.textContent('#ap-bars .fix-bar.is-warn')).includes('Заблокирован выход в сеть'), 'панель объясняет блокировку');

  // --- Схема Mermaid прямо в чате ---
  await send(page, 'Нарисуй схему');
  await page.waitForSelector(`${last} .ac-mermaid svg`, { timeout: 15000 });
  assert((await page.textContent(`${last} .ac-mermaid svg`)).includes('Есть в памяти?'), 'схема нарисована в чате');
  await page.waitForSelector('#ap-view .ap-mermaid svg');
  assert(true, 'схема открыта в панели');
  await page.screenshot({ path: OUT + '/a3-mermaid.png' });

  // --- SVG: показывается картинкой, скрипт внутри не выполняется ---
  await send(page, 'Нарисуй svg солнце');
  await page.waitForSelector(`${last} img.ac-preview`);
  await page.waitForTimeout(300);
  assert(dialogs === 0, 'скрипт внутри SVG не выполнился');

  // --- Оборванный ответ ---
  await send(page, 'Сделай длинную игру');
  assert((await page.textContent(`${last} .ac-sub`)).includes('код оборвался'), 'карточка: код оборвался');
  await page.waitForSelector('#ap-bars .fix-bar.is-warn');
  assert((await page.textContent('#ap-bars')).includes('Увеличьте размер контекста'), 'панель советует, что делать');

  // --- Esc закрывает панель; после перезагрузки карточки на месте ---
  // Пока фокус в игре, Esc получает игра (часто это «пауза»); вне игры — закрывает панель
  await page.click('#input');
  await page.keyboard.press('Escape');
  assert(await page.isHidden('#artifact-panel'), 'Esc закрывает панель');
  await page.reload();
  await page.waitForSelector('.artifact-card');
  assert(await page.$$eval('.artifact-card', (c) => c.length) === 8, 'все артефакты восстановились из истории');
  assert(await page.isHidden('#artifact-panel'), 'после загрузки истории панель сама не открывается');
  await page.click('.artifact-card .ac-open');
  await artifactFrame(page);
  assert(await page.$$eval('#ap-version option', (o) => o.length) === 3, 'версии восстановились');

  // --- Телефон: панель поверх чата ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(page.url());
  await mobile.waitForSelector('.artifact-card');
  assert(await mobile.isHidden('#artifact-panel'), 'на телефоне сама не открывается');
  await mobile.click('.artifact-card .ac-open');
  await mobile.waitForSelector('#ap-view iframe');
  const box = await mobile.$eval('#artifact-panel', (p) => p.getBoundingClientRect().width);
  assert(box === 390, 'на телефоне панель на весь экран');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');
  await mobile.screenshot({ path: OUT + '/a4-mobile.png' });
  await mobile.click('#ap-close');
  assert(await mobile.isHidden('#artifact-panel'), 'закрывается кнопкой');

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 10 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
