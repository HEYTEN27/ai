// Сквозная проверка голографического интерфейса (тема HUD): заставка, ядро, приветствие
// «…, сэр», озвучивание ответов, смена обращения и темы.
// Голос Windows подменяется заглушкой speechSynthesis — звуковая карта не нужна.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();

// Поддельный speechSynthesis: офлайн-голос «Pavel» и сетевой Google (его показывать нельзя)
function fakeSpeech() {
  window.__spoken = [];
  const pavel = { name: 'Microsoft Pavel - Russian (Russia)', lang: 'ru-RU', localService: true };
  const google = { name: 'Google русский', lang: 'ru-RU', localService: false };
  const english = { name: 'Microsoft David - English', lang: 'en-US', localService: true };
  const synth = {
    speaking: false, pending: false,
    getVoices: () => [english, google, pavel],
    // Фразы звучат по очереди, каждая ~0,8 с — как у настоящего синтезатора
    queue: [],
    speak(u) {
      window.__spoken.push({ text: u.text, voice: u.voice?.name });
      synth.queue.push(u);
      if (!synth.speaking) synth.next();
    },
    next() {
      const u = synth.queue.shift();
      synth.speaking = Boolean(u);
      if (!u) return;
      setTimeout(() => { u.onstart?.(); synth.timer = setTimeout(() => { u.onend?.(); synth.next(); }, 800); }, 10);
    },
    cancel() { synth.queue = []; clearTimeout(synth.timer); synth.speaking = false; },
    addEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
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
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  await ctx.addInitScript(fakeSpeech);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // --- Заставка загрузки (?boot показывает её даже в автотесте) ---
  await page.goto('http://127.0.0.1:8000/?boot');
  await page.waitForSelector('.boot .boot-lines li:has-text("Языковое ядро")', { timeout: 8000 });
  const bootLines = await page.$$eval('.boot-lines li', (l) => l.map((x) => x.textContent));
  assert(bootLines.some((t) => t.includes('qwen3:8b')), 'заставка: строка про языковое ядро с моделью');
  await page.screenshot({ path: OUT + '/hud1-boot.png' });
  await page.mouse.click(600, 400); // клик пропускает заставку
  await page.waitForSelector('.boot', { state: 'detached', timeout: 5000 });
  assert(true, 'заставка пропускается кликом');

  // --- Тема, ядро, часы, приветствие ---
  await page.waitForSelector('#conn-status.is-ok');
  assert(await page.getAttribute('html', 'data-theme') === 'hud', 'тема HUD по умолчанию');
  assert(await page.$$eval('.brand-core svg.core, .empty-core svg.core', (s) => s.length) === 2, 'ядро в логотипе и на пустом экране');
  assert(await page.getAttribute('body', 'data-core') === 'idle', 'ядро в покое');
  assert(/^\d\d:\d\d:\d\d/.test(await page.textContent('#hud-clock')), 'часы в верхней панели');
  await page.waitForFunction(() => document.querySelector('#greeting').textContent.endsWith(', сэр.'));
  assert(/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), сэр\.$/.test(await page.textContent('#greeting')), 'приветствие по времени суток «…, сэр.»');
  assert((await page.textContent('#greeting-sub')) === 'Джарвис на связи. Чем могу помочь?', 'подзаголовок «Чем могу помочь?»');
  // Часы не обрезаны правым краем
  const clockBox = await page.$eval('#hud-clock', (e) => e.getBoundingClientRect().right);
  assert(clockBox <= 1366, 'часы целиком помещаются в панель');

  // --- Озвучивание: только офлайн-голос ---
  await page.waitForSelector('#tts-toggle:not([hidden])');
  assert((await page.getAttribute('#tts-toggle', 'title')).includes('Pavel'), 'кнопка озвучки видна, выбран офлайн-голос Pavel');
  assert(await page.getAttribute('#tts-toggle', 'aria-pressed') === 'true', 'автоозвучка включена по умолчанию');

  await page.fill('#input', 'Объясни замыкания в JavaScript');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert(await page.getAttribute('body', 'data-core') === 'thinking', 'во время ответа ядро «думает»');
  await page.waitForSelector('.msg-assistant .msg-meta:not([hidden])', { timeout: 15000 });
  const req = await lastRequest();
  assert(req.messages[0].content.includes('Да, сэр.'), 'персона Джарвис: в инструкции «Да, сэр.»');
  await page.waitForFunction(() => window.__spoken.length > 0);
  let spoken = await page.evaluate(() => window.__spoken);
  const said = spoken.map((s) => s.text).join(' ');
  assert(spoken.every((s) => s.voice === 'Microsoft Pavel - Russian (Russia)'), 'говорит офлайн-голосом, не сетевым Google');
  assert(said.includes('Код — на экране') && !said.includes('def hello') && !said.includes('**'), 'код и markdown не зачитываются');
  await page.waitForFunction(() => document.body.dataset.core === 'speaking', null, { timeout: 2000 });
  assert(true, 'пока звучит голос, ядро в режиме «говорит»');
  await page.waitForFunction(() => document.body.dataset.core === 'idle', null, { timeout: 5000 });
  assert(true, 'после озвучки ядро в покое');
  await page.screenshot({ path: OUT + '/hud2-answer.png' });

  // Выключить автоозвучку кнопкой в панели — сохраняется в настройках
  await page.click('#tts-toggle');
  assert(await page.getAttribute('#tts-toggle', 'aria-pressed') === 'false', 'озвучка выключена');
  await page.waitForTimeout(200);
  const settings = await (await fetch('http://127.0.0.1:8000/api/settings')).json();
  assert(settings.values.tts_enabled === false, 'выключение озвучки сохранено');
  const count = await page.evaluate(() => window.__spoken.length);
  await send(page, 'Ещё пример');
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => window.__spoken.length) === count, 'без автоозвучки новый ответ не читается');
  // Но кнопка 🔊 под ответом читает его по требованию
  await page.click('.msg-assistant:last-child .btn-speak');
  await page.waitForFunction((n) => window.__spoken.length > n, count);
  assert(true, 'кнопка «Прочитать вслух» под ответом работает');

  // --- Настройки: голоса, обращение ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=data]');
  await page.waitForFunction(() => document.querySelectorAll('#tts-voice option').length > 1);
  const voices = await page.$$eval('#tts-voice option', (o) => o.map((x) => x.textContent));
  assert(voices.includes('Microsoft Pavel - Russian (Russia)') && !voices.some((v) => v.includes('Google') || v.includes('David')),
    'в списке только русские офлайн-голоса');
  await page.click('.tab[data-tab=general]');
  await page.fill('#set-address', 'босс');
  await page.click('#general-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  await page.click('#new-chat-btn');
  await page.waitForFunction(() => document.querySelector('#greeting').textContent.endsWith(', босс.'));
  assert(true, 'новое обращение в приветствии');
  await send(page, 'Привет');
  const req2 = await lastRequest();
  assert(req2.messages[0].content.includes('Да, босс.') && !req2.messages[0].content.includes('{address}'), 'обращение подставлено в инструкцию модели');

  // --- Классическая тема ---
  await page.click('#settings-btn');
  await page.selectOption('#set-theme', 'classic');
  await page.click('#general-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'classic');
  await page.click('#new-chat-btn');
  assert(await page.isHidden('.empty-core') && await page.isHidden('#hud-clock'), 'в классической теме нет ядра и часов');
  assert((await page.textContent('#greeting')) === 'Джарвис на связи. Чем помочь?', 'классическое приветствие');
  await page.reload();
  await page.waitForSelector('#conn-status.is-ok');
  assert(await page.getAttribute('html', 'data-theme') === 'classic', 'тема сохраняется после перезагрузки');
  await page.screenshot({ path: OUT + '/hud3-classic.png' });

  // Вернуть HUD
  await page.click('#settings-btn');
  await page.selectOption('#set-theme', 'hud');
  await page.click('#general-form button[type=submit]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'hud');
  assert(true, 'возврат к теме HUD');

  // --- Телефон: без горизонтальной прокрутки ---
  const mobile = await ctx.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/');
  await mobile.waitForSelector('#conn-status.is-ok');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');
  await mobile.screenshot({ path: OUT + '/hud4-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ HUD ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
