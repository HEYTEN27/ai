// Сквозная проверка этапа 13: рисование картинок — скачивание модели, страница «Изображения»,
// галерея и просмотрщик, инструмент в чате с прогрессом, «Ещё вариант».
// Движок — заглушка (рисует градиенты): сервер запускать с IMAGE_ENGINE=fake FAKE_IMAGE_STEP=0.04.
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const last = '.msg-assistant:last-child';

async function send(page, text) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  return before;
}

async function waitAnswer(page, before) {
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 30000 });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Пока модель не скачана, инструмента рисования у модели нет ---
  let before = await send(page, 'Нарисуй кота');
  await waitAnswer(page, before);
  assert(await page.$(`${last} .tool-card`) === null, 'без скачанной модели Джарвис не рисует');

  // --- Страница «Изображения»: скачать модель ---
  await page.click('#images-btn');
  await page.waitForSelector('.img-model[data-model=dreamshaper]');
  assert(await page.$$eval('.img-model', (m) => m.length) === 2, 'две модели: DreamShaper и SDXL Turbo');
  assert(await page.isDisabled('#img-go'), 'рисовать пока нечем');
  await page.click('.img-model[data-model=dreamshaper] .tv-download');
  await page.waitForSelector('#img-dl:not([hidden])');
  assert((await page.textContent('#img-dl-text')).includes('Скачиваю «dreamshaper»'), 'прогресс скачивания модели');
  await page.waitForSelector('.img-model[data-model=dreamshaper] .tv-state', { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('img-go').disabled);
  assert(true, 'модель скачана — можно рисовать');

  // --- Рисование со страницы ---
  await page.fill('#img-prompt', 'кот в космосе');
  await page.selectOption('#img-orientation', 'landscape');
  await page.click('#img-go');
  await page.waitForFunction(() => /Рисую: шаг \d+ из 25/.test(document.getElementById('img-run-text').textContent), null, { timeout: 15000 });
  assert(true, 'прогресс: «Рисую: шаг N из 25»');
  await page.screenshot({ path: OUT + '/i1-drawing.png' });
  await page.waitForSelector('#img-gallery .img-thumb', { timeout: 30000 });
  assert(await page.isHidden('#img-run'), 'прогресс убран после рисования');
  const size = await page.$eval('#img-gallery .img-thumb img', (i) => new Promise((ok) => (i.complete ? ok([i.naturalWidth, i.naturalHeight])
    : i.addEventListener('load', () => ok([i.naturalWidth, i.naturalHeight])))));
  assert(size[0] === 768 && size[1] === 512, `формат «пейзаж» 768×512: ${size}`);

  // --- Просмотрщик ---
  await page.click('#img-gallery .img-thumb');
  await page.waitForSelector('#img-lightbox[open]');
  assert((await page.textContent('#lb-request')) === '«кот в космосе»', 'в просмотрщике — исходная просьба');
  assert((await page.textContent('#lb-meta')).includes('768×512') && (await page.textContent('#lb-meta')).includes('seed'), 'размер и seed');
  await page.screenshot({ path: OUT + '/i2-lightbox.png' });
  await page.click('#lb-more'); // «Ещё вариант» — та же просьба
  await page.waitForFunction(() => document.querySelectorAll('#img-gallery .img-thumb').length === 2, null, { timeout: 30000 });
  assert(true, '«Ещё вариант» из просмотрщика');
  await page.click('#img-gallery .img-thumb');
  page.once('dialog', (d) => d.accept());
  await page.click('#lb-delete');
  await page.waitForFunction(() => document.querySelectorAll('#img-gallery .img-thumb').length === 1);
  assert(true, 'картинку можно удалить');

  // --- Рисование в чате ---
  await page.click('#new-chat-btn');
  before = await send(page, 'Нарисуй кота, два варианта');
  await page.waitForSelector(`${last} .tool-card[data-tool=generate_image] .img-progress`, { timeout: 15000 });
  assert((await page.textContent(`${last} .tool-card .t-title`)) === 'Рисую', 'карточка «Рисую» с прогрессом');
  await waitAnswer(page, before);
  assert(await page.$$eval(`${last} .img-grid .img-thumb`, (t) => t.length) === 2, 'два варианта в чате');
  assert(await page.$(`${last} .img-progress`) === null, 'прогресс убран');
  assert((await page.textContent(`${last} .img-caption`)).startsWith('a cute red cat'), 'видно английский промпт');
  await page.click(`${last} .img-more`);
  await page.waitForFunction(() => document.querySelectorAll('.msg-assistant:last-child .img-grid .img-thumb').length === 3, null, { timeout: 30000 });
  assert(true, '«Ещё вариант» в чате');
  await page.screenshot({ path: OUT + '/i3-chat.png' });
  await page.reload();
  await page.waitForSelector('.img-grid .img-thumb');
  assert(await page.$$eval('.img-grid .img-thumb', (t) => t.length) === 3, 'после перезагрузки все три варианта на месте');
  await page.click('.img-grid .img-thumb');
  await page.waitForSelector('#img-lightbox[open]');
  assert(await page.isHidden('#lb-delete'), 'в чате картинку не удалить (только в галерее)');
  await page.click('#lb-close');

  // --- Галерея видит и картинки из чата ---
  await page.click('#images-btn');
  await page.waitForFunction(() => document.querySelectorAll('#img-gallery .img-thumb').length === 4);
  assert(true, 'галерея: 1 со страницы + 3 из чата');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/#/images');
  await mobile.waitForSelector('#img-gallery .img-thumb');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');
  await mobile.screenshot({ path: OUT + '/i4-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 13 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
