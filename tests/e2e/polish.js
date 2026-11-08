// Сквозная проверка этапа 8: голосовой ввод (поддельный микрофон Chromium) и экспорт диалогов.
// Запуск: эмулятор Ollama на :11434 и сервер `python tests/e2e/serve_fake_voice.py` (с чистым DATA_DIR).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const APP = 'http://127.0.0.1:8000';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };

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
  // Поддельный микрофон: Chromium сам «говорит» тестовым сигналом, без запроса разрешения
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'], acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(APP + '/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Голосовой ввод ---
  await page.waitForSelector('#mic-btn:not([hidden])');
  assert(true, 'кнопка микрофона видна');
  await page.fill('#input', 'Начало:');
  page.once('dialog', (d) => { assert(d.message().includes('скачается модель'), 'перед первой записью предупреждает о скачивании модели'); d.accept(); });
  await page.click('#mic-btn');
  await page.waitForSelector('#mic-btn.recording');
  await page.waitForTimeout(1600);
  assert((await page.textContent('#mic-timer')).startsWith('0:01'), 'таймер записи идёт');
  await page.screenshot({ path: OUT + '/p1-recording.png' });
  await page.click('#mic-btn');
  await page.waitForFunction(() => document.querySelector('#input').value.includes('Проверка голоса'), null, { timeout: 15000 });
  const value = await page.inputValue('#input');
  console.log('  в поле ввода:', JSON.stringify(value));
  assert(/^Начало: Проверка голоса \(1\.\d с\)$/.test(value), 'распознанный текст вставлен после курсора (запись из браузера декодирована на сервере)');
  assert(!(await page.isVisible('#mic-btn.recording')), 'запись остановлена');

  // Esc отменяет запись
  await page.click('#mic-btn');
  await page.waitForSelector('#mic-btn.recording');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#mic-btn:not(.recording)');
  await page.waitForTimeout(800);
  assert((await page.inputValue('#input')) === value, 'Esc — запись отменена, текст не добавлен');

  // --- Экспорт одного диалога ---
  await page.fill('#input', '');
  await send(page, 'Что такое замыкание?');
  await page.hover('.conv-item.active');
  await page.click('.conv-item.active .icon-btn[title="Скачать диалог"]');
  await page.waitForSelector('.export-menu');
  await page.screenshot({ path: OUT + '/p2-export-menu.png' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.export-menu a:has-text("Markdown")')]);
  const md = fs.readFileSync(await download.path(), 'utf-8');
  assert(download.suggestedFilename().endsWith('Что такое замыкание.md'), `имя файла по-русски: ${download.suggestedFilename()}`);
  assert(md.startsWith('# Что такое замыкание?') && md.includes('### 🧑 Вы') && md.includes('### 🤖 Джарвис'), 'Markdown с вопросом и ответом');
  await page.waitForSelector('.export-menu', { state: 'detached' });
  assert(true, 'меню закрылось после скачивания');

  // --- Настройки «Голос и данные» ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=data]');
  await page.waitForSelector('#data-form:not([hidden])');
  // Список моделей приходит с сервера чуть позже, чем открывается вкладка
  await page.waitForFunction(() => document.querySelectorAll('#v-model option').length > 0);
  assert((await page.$$eval('#v-model option', (o) => o.length)) === 4, 'выбор модели распознавания');
  const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#data-form a[href="/api/export/all"]')]);
  const zipBytes = fs.readFileSync(await zip.path());
  assert(zipBytes.slice(0, 2).toString() === 'PK' && zip.suggestedFilename().endsWith('.zip'), 'архив всех диалогов');
  await page.screenshot({ path: OUT + '/p3-data-tab.png' });
  await page.uncheck('#v-enabled', { force: true });
  await page.click('#data-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  await page.waitForSelector('#mic-btn', { state: 'hidden' });
  assert(true, 'голос выключен — кнопка микрофона скрыта');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(APP + '/');
  await mobile.waitForSelector('#conn-status.is-ok');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'без горизонтальной прокрутки на телефоне');

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 8 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
