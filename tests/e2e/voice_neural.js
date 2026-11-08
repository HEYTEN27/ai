// Сквозная проверка этапа 12: нейроголос Piper — скачивание голоса с прогрессом, озвучка
// по предложениям ВО ВРЕМЯ ответа, «Стоп», выключение озвучки, удаление голоса.
// Голос — пустышка (tests/fake_piper.py), «HuggingFace» изображает эмулятор Ollama.
// Сервер запускать так (см. tests/e2e/README.md):
//   PIPER_VOICES_URL=http://127.0.0.1:11434/_voices DATA_DIR=... python -m backend
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Все запросы синтеза: текст и время
  const synth = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/voice/tts') && r.method() === 'POST') synth.push({ text: JSON.parse(r.postData()).text, at: Date.now() });
  });

  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');
  await page.waitForTimeout(500);
  assert(await page.isHidden('#tts-toggle'), 'без голоса кнопки 🔊 нет (в headless нет и голосов Windows)');

  // --- Скачивание голоса в настройках ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=data]');
  await page.waitForSelector('.tts-voice[data-voice=ruslan]');
  assert(await page.inputValue('#tts-engine') === 'neural', 'по умолчанию — нейроголос');
  assert(await page.$$eval('.tts-voice', (v) => v.length) === 4, 'четыре русских голоса');
  assert((await page.textContent('.tts-voice[data-voice=ruslan] .tv-title')).includes('рекомендую'), 'Руслан рекомендован');
  assert(await page.isDisabled('#tts-test'), 'пока голос не скачан — проверить нечего');
  await page.click('.tts-voice[data-voice=ruslan] .tv-download');
  await page.waitForSelector('#tts-progress:not([hidden])');
  assert((await page.textContent('#tts-progress-text')).includes('Скачиваю голос «ruslan»'), 'прогресс скачивания');
  await page.screenshot({ path: OUT + '/v1-download.png' });
  await page.waitForSelector('.tts-voice[data-voice=ruslan] .tv-state:has-text("скачан")', { timeout: 20000 });
  assert(await page.isEnabled('#tts-test'), 'голос скачан — можно проверить');
  await page.click('#tts-test');
  await page.waitForFunction(() => document.body.dataset.core === 'speaking', null, { timeout: 5000 });
  assert(synth.at(-1).text.startsWith('Все системы в норме, сэр.'), 'проверка голоса — запрос синтеза');
  await page.screenshot({ path: OUT + '/v2-voices.png' });
  await page.click('#data-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  await page.waitForSelector('#tts-toggle:not([hidden])');
  assert((await page.getAttribute('#tts-toggle', 'title')).includes('нейроголос «ruslan»'), 'кнопка 🔊 появилась');
  await page.waitForFunction(() => document.body.dataset.core === 'idle', null, { timeout: 10000 });

  // --- Озвучка во время ответа ---
  synth.length = 0;
  await page.fill('#input', 'Расскажи про замыкания');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.dataset.core === 'speaking', null, { timeout: 10000 });
  await page.waitForSelector('.msg-assistant .msg-meta:not([hidden])', { timeout: 20000 });
  const doneAt = Date.now();
  assert(synth.length > 0 && synth[0].at < doneAt, 'первое предложение ушло на синтез ДО конца ответа');
  assert(synth[0].text.startsWith('Вы спросили:'), 'начинает с первого предложения');
  await page.waitForFunction(() => document.body.dataset.core === 'idle', null, { timeout: 20000 });
  const said = synth.map((s) => s.text).join(' ');
  assert(said.includes('Код — на экране.') && !said.includes('def hello') && !said.includes('**'),
    'код и разметка не зачитываются');
  assert(said.includes('пункт второй'), 'дочитан хвост ответа после конца стрима');
  console.log('  фразы:', synth.map((s) => s.text));

  // --- «Стоп» — замолкаем ---
  await page.fill('#input', 'Ещё раз расскажи');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.dataset.core === 'speaking', null, { timeout: 10000 });
  await page.click('#send-btn'); // во время генерации это «Стоп»
  await page.waitForTimeout(300);
  const afterStop = synth.length;
  await page.waitForTimeout(1500);
  assert(synth.length === afterStop, '«Стоп» — новых фраз на синтез нет');
  assert(await page.evaluate(() => document.body.dataset.core) === 'idle', 'ядро в покое');

  // --- Озвучка выключена кнопкой 🔊 ---
  await page.click('#tts-toggle');
  synth.length = 0;
  await page.fill('#input', 'Третий вопрос');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msg-assistant .msg-meta:not([hidden])').length >= 3);
  await page.waitForTimeout(500);
  assert(synth.length === 0, 'озвучка выключена — ответ не читается');
  // Но кнопка 🔊 под ответом читает по требованию
  await page.click('.msg-assistant:last-child .btn-speak');
  await page.waitForFunction(() => document.body.dataset.core === 'speaking', null, { timeout: 5000 });
  assert(synth.length > 0, '«Прочитать вслух» под ответом — нейроголосом');
  await page.click('.msg-assistant:last-child .btn-speak'); // повторный клик — замолчать
  await page.waitForFunction(() => document.body.dataset.core === 'idle');

  // --- Удаление голоса ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=data]');
  page.once('dialog', (d) => d.accept());
  await page.click('.tts-voice[data-voice=ruslan] .link-btn.danger');
  await page.waitForSelector('.tts-voice[data-voice=ruslan] .tv-download');
  await page.click('#data-form button[type=submit]');
  await page.waitForSelector('#tts-toggle', { state: 'hidden' });
  assert(true, 'голос удалён — кнопки 🔊 снова нет');

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 12 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
