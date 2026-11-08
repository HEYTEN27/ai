// Сквозная проверка этапа 14: зрение — вставка скриншота, подсказка без модели зрения,
// скачивание модели в настройках, ответ модели зрения, уточняющий вопрос, миниатюры.
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
  if (text !== null) await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    const lastMsg = all[all.length - 1];
    return all.length > n && (!lastMsg.querySelector('.msg-meta').hidden || lastMsg.querySelector('.msg-error'));
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

  // --- Вставка скриншота из буфера обмена (Ctrl+V) ---
  await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 1920, 1080);
    ctx.fillStyle = '#f55'; ctx.font = '80px sans-serif'; ctx.fillText('TypeError: x is undefined', 100, 500);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.attach-chip.is-ready .a-icon.has-thumb img');
  assert((await page.textContent('.attach-chip .a-info')).includes('1920×1080'), 'скриншот вставлен: миниатюра и размер');
  await page.screenshot({ path: OUT + '/vi1-pasted.png' });

  // --- Без модели зрения — понятная подсказка ---
  await send(page, 'Что за ошибка на скрине?');
  assert((await page.textContent(`${last} .msg-error`)).includes('нужна модель зрения'), 'подсказка, как скачать модель зрения');
  assert(await page.$('.msg-user .file-thumb img') !== null, 'картинка видна в сообщении миниатюрой');

  // --- Скачивание модели зрения в настройках ---
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.querySelectorAll('#set-vision option').length >= 4);
  assert(await page.inputValue('#set-vision') === 'qwen3-vl:8b', 'по умолчанию — qwen3-vl:8b');
  assert((await page.textContent('#vision-note')).includes('Не скачана'), 'видно, что модель не скачана');
  await fetch(FAKE + '/_test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pull_delay: 0.25 }) });
  await page.click('#vision-pull');
  await page.waitForSelector('#vision-progress:not([hidden])');
  await page.waitForFunction(() => /Скачиваю qwen3-vl:8b: \d+%/.test(document.getElementById('vision-progress-text').textContent));
  assert(true, 'прогресс скачивания модели зрения');
  await page.screenshot({ path: OUT + '/vi2-pull.png' });
  await page.waitForFunction(() => document.getElementById('vision-note').textContent.startsWith('Скачана'), null, { timeout: 15000 });
  assert((await page.textContent('#set-vision option:checked')).startsWith('✓'), 'модель зрения скачана');
  await page.click('#general-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });

  // --- Вопрос с картинкой: отвечает модель зрения ---
  await page.click('#new-chat-btn');
  const png = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 3000, height: 2000 });
    canvas.getContext('2d').fillRect(0, 0, 10, 10);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('#attach-input', { name: 'фото задачи.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForSelector('.attach-chip.is-ready');
  await send(page, 'Реши задачу с фото');
  assert((await page.textContent(`${last} .content`)).startsWith('Вижу изображений: 1 (1280x853)'), 'модель зрения получила уменьшенную картинку');
  assert((await page.textContent(`${last} .meta-text`)).includes('qwen3-vl:8b'), 'подписано, какая модель ответила');
  assert((await page.textContent(`${last} .meta-vision`)).includes('👁 1 картинка'), 'отметка «👁 1 картинка»');
  assert((await page.getAttribute(`${last} .meta-vision`, 'title')).includes('вместо qwen3:8b'), 'видно, что модель подменили');
  let req = await lastRequest();
  assert(req.model === 'qwen3-vl:8b' && req.messages.at(-1).images.length === 1, 'в Ollama ушла картинка');
  await page.screenshot({ path: OUT + '/vi3-answer.png' });

  // --- Уточняющий вопрос ---
  await send(page, 'А какой ответ во втором пункте?');
  assert((await page.textContent(`${last} .content`)).startsWith('Вижу изображений: 1'), 'уточняющий вопрос всё ещё видит картинку');

  // --- Просмотр картинки ---
  await page.click('.msg-user .file-thumb');
  await page.waitForSelector('#img-lightbox[open]');
  assert((await page.textContent('#lb-request')).includes('фото задачи.png'), 'картинку можно открыть крупно');
  await page.click('#lb-close');

  // --- После перезагрузки ---
  await page.reload();
  await page.waitForSelector('.msg-user .file-thumb img');
  assert(await page.$('.meta-vision') !== null, 'отметка «👁» сохранилась');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(page.url());
  await mobile.waitForSelector('.msg-user .file-thumb img');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 14 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
