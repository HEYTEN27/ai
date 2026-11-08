// Сквозная проверка этапа 7: страница «Обучение» — готовность датасета, пакет для Colab,
// подключение «обученной» модели к Ollama (эмулятор принимает файлы через /api/blobs и /api/create).
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const APP = 'http://127.0.0.1:8000';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-e2e-'));
const gguf = path.join(dir, 'jarvis-qwen3.Q4_K_M.gguf');
fs.writeFileSync(gguf, 'GGUF');
fs.truncateSync(gguf, 101 * 1024 * 1024); // «полная модель» должна весить больше 100 МБ
const adapter = path.join(dir, 'jarvis-qwen3-lora.gguf');
fs.writeFileSync(adapter, 'GGUF-lora'.repeat(1000));

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 422/.test(m.text())) errors.push(m.text()); });

  await page.goto(APP + '/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Пустой датасет ---
  await page.click('#training-btn');
  await page.waitForSelector('#training-view:not([hidden]) #tr-checks li');
  assert(page.url().endsWith('#/training'), 'адрес #/training');
  assert(await page.isVisible('#tr-checks li.error'), 'пустой датасет — ошибка в шаге 1');
  assert(await page.isVisible('#tr-package.disabled'), 'кнопка пакета недоступна без датасета');

  // --- Собираем пару примеров ---
  await page.click('#new-chat-btn');
  for (const q of ['Что такое REST API?', 'Чем let отличается от var?']) {
    await send(page, q);
    await page.locator('.msg-assistant').last().locator('.btn-like').click();
    await page.waitForFunction(() => document.querySelector('.msg-assistant:last-child .btn-like.active'));
  }
  await page.click('#training-btn');
  await page.waitForSelector('#tr-checks li.warn');
  assert((await page.textContent('#tr-checks')).includes('мало'), 'мало примеров — честное предупреждение');
  assert((await page.textContent('#tr-config')).includes('эпох — 3'), 'рекомендованы 3 эпохи');
  assert(!(await page.isVisible('#tr-package.disabled')), 'пакет можно скачать');
  const pkg = await page.request.get(APP + (await page.getAttribute('#tr-package', 'href')));
  const bytes = await pkg.body();
  assert(pkg.headers()['content-type'] === 'application/zip' && bytes.slice(0, 2).toString() === 'PK', 'пакет — zip-архив');
  await page.screenshot({ path: OUT + '/tr1-training.png', fullPage: true });

  // --- Ошибка ввода ---
  await page.fill('#tr-path', path.join(dir, 'нет-такого.gguf'));
  await page.click('#tr-import-btn');
  await page.waitForSelector('#tr-stage.error');
  assert((await page.textContent('#tr-stage')).includes('не найден'), 'несуществующий файл — понятная ошибка');

  // --- Подключение полной модели ---
  await page.fill('#tr-path', gguf);
  await page.click('#tr-import-btn');
  await page.waitForSelector('#tr-stage.ok', { timeout: 30000 });
  assert((await page.textContent('#tr-stage')).includes('jarvis-qwen3:latest'), 'модель подключена');
  await page.waitForFunction(() => [...document.querySelectorAll('#model-select option')].some((o) => o.value === 'jarvis-qwen3:latest'));
  assert(true, 'новая модель появилась в списке моделей');
  assert((await page.textContent('#tr-models')).includes('jarvis-qwen3:latest'), 'в списке подключённых');
  await page.screenshot({ path: OUT + '/tr2-imported.png' });

  // --- Адаптер ---
  await page.fill('#tr-path', adapter);
  await page.fill('#tr-name', 'jarvis-lora');
  await page.check('input[name=tr-kind][value=adapter]');
  assert(await page.isDisabled('#tr-quantize'), 'для адаптера сжатие недоступно');
  await page.click('#tr-import-btn');
  await page.waitForSelector('#tr-stage.ok', { timeout: 30000 });
  assert((await page.textContent('#tr-stage')).includes('jarvis-lora:latest'), 'адаптер подключён');

  // --- Чат с дообученной моделью ---
  await page.click('#new-chat-btn');
  await page.selectOption('#model-select', 'jarvis-qwen3:latest');
  await send(page, 'Привет, ты дообученная версия?');
  assert((await page.textContent('.msg-assistant .meta-text')).includes('jarvis-qwen3:latest'), 'дообученная модель отвечает в чате');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(APP + '/#/training');
  await mobile.waitForSelector('#tr-checks li');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'страница обучения без горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/tr3-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 7 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
