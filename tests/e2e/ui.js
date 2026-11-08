// Сквозная проверка интерфейса этапа 1
const { chromium } = require('playwright');
// Скриншоты складываются в tests/e2e/screenshots (папка в .gitignore)
const OUT = process.env.SCREENSHOT_DIR || require('path').join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');
  assert(await page.textContent('.conn-text') === 'Ollama 0.34.4-fake', 'статус Ollama');
  assert(await page.title() === 'Джарвис', 'имя ассистента во вкладке');
  // Тема HUD: приветствие по времени суток печатается по буквам, имя — в подзаголовке
  await page.waitForFunction(() => document.querySelector('#greeting').textContent.endsWith(', сэр.'));
  assert(/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), сэр\.$/.test(await page.textContent('#greeting')), 'приветствие «…, сэр.»');
  assert((await page.textContent('#greeting-sub')).startsWith('Джарвис на связи'), 'подзаголовок с именем');
  await page.waitForFunction(() => document.querySelectorAll('#model-select option').length >= 3);
  const options = await page.$$eval('#model-select option', o => o.map(x => x.textContent));
  console.log('  модели:', options);
  assert(await page.inputValue('#model-select') === 'qwen3:8b', 'по умолчанию qwen3:8b');
  assert(options.at(-1).includes('медленно, частично на CPU'), 'большая модель помечена и внизу');
  assert(!options.some(o => o.includes('bge-m3')), 'эмбеддинги не в списке');
  assert(await page.isVisible('#think-toggle-wrap'), 'переключатель «Размышлять» виден для qwen3');
  await page.waitForFunction(() => document.querySelector('.vram-text').textContent !== '—');
  assert((await page.textContent('.vram-text')) === 'не загружена', 'VRAM: не загружена');
  await page.screenshot({ path: OUT + '/1-empty.png' });

  // --- Отправка сообщения, стриминг ---
  await page.fill('#input', 'Как написать функцию приветствия на Python?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.streaming');
  assert(await page.isVisible('#send-btn.is-stop'), 'кнопка стала «Стоп»');
  await page.waitForTimeout(400);
  const partial = await page.textContent('.msg-assistant .content');
  await page.screenshot({ path: OUT + '/2-streaming.png' });
  await page.waitForSelector('.msg-assistant .msg-meta:not([hidden])', { timeout: 15000 });
  const full = await page.textContent('.msg-assistant .content');
  assert(full.length > partial.length, `текст рос постепенно (${partial.length} → ${full.length})`);
  assert(await page.$('.code-block .hljs') !== null, 'код подсвечен');
  assert(await page.$('.code-header button') !== null, 'кнопка «Копировать» у кода');
  assert((await page.textContent('.meta-text')).includes('ток/с'), 'скорость генерации показана');
  assert(page.url().includes('#/c/'), 'id диалога в адресе');
  await page.waitForFunction(() => document.querySelector('.vram-text').textContent.startsWith('GPU 100%'));
  assert(true, 'VRAM: GPU 100% после загрузки');
  await page.waitForSelector('.conv-item.active');
  const title = await page.textContent('.conv-item.active .conv-title');
  assert(title === 'Как написать функцию приветствия на Python?', 'название диалога из первого сообщения');
  await page.screenshot({ path: OUT + '/3-answer.png' });

  // --- Размышления ---
  await page.check('#think-toggle', { force: true });
  await page.fill('#input', 'А теперь подумай');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg-assistant:last-child .thinking:not([hidden])');
  await page.waitForSelector('.msg-assistant:last-child .msg-meta:not([hidden])', { timeout: 15000 });
  assert(await page.$eval('.msg-assistant:last-child .thinking', d => !d.open), 'размышления свёрнуты после ответа');
  await page.click('.msg-assistant:last-child .thinking summary');
  await page.screenshot({ path: OUT + '/4-thinking.png' });

  // --- Стоп ---
  await page.fill('#input', 'Расскажи длинно');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg-assistant:last-child.streaming');
  await page.waitForTimeout(300);
  await page.click('#send-btn');
  await page.waitForSelector('.msg-assistant:last-child .tag-stopped');
  assert(true, 'генерация остановлена, есть пометка');
  await page.waitForTimeout(500); // сервер сохраняет частичный ответ

  // --- После перезагрузки история на месте ---
  await page.reload();
  await page.waitForSelector('.msg-assistant');
  const count = await page.$$eval('.msg', m => m.length);
  assert(count === 6, `история восстановилась после перезагрузки (${count} сообщений)`);
  assert(await page.$('.msg-assistant:last-child .tag-stopped') !== null, 'пометка «остановлено» сохранилась');

  // --- Повторить другой моделью ---
  await page.selectOption('#model-select', 'llama3.1:8b');
  assert(!(await page.isVisible('#think-toggle-wrap')), 'у llama3.1 нет переключателя «Размышлять»');
  await page.click('.msg-assistant:last-child .btn-retry');
  await page.waitForSelector('.msg-assistant:last-child .msg-meta:not([hidden]) .meta-text:has-text("llama3.1")', { timeout: 15000 });
  assert((await page.$$('.msg')).length === 6, 'ответ заменён, а не добавлен');

  // --- Большая модель → предупреждение VRAM ---
  await page.selectOption('#model-select', 'qwen3:14b');
  await page.fill('#input', 'Проверка большой модели');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg-assistant:last-child .msg-meta:not([hidden])', { timeout: 15000 });
  await page.waitForSelector('#banner:not([hidden])');
  const banner = await page.textContent('#banner');
  assert(banner.includes('62%'), 'предупреждение о выгрузке в RAM');
  assert(await page.isVisible('#vram-indicator.is-warn'), 'индикатор VRAM жёлтый');
  await page.screenshot({ path: OUT + '/5-vram-warning.png' });

  // --- Новый чат, переименование, удаление ---
  await page.click('#new-chat-btn');
  assert(await page.isVisible('#empty-state'), 'новый чат показывает пустой экран');
  await page.click('.suggestion >> nth=0');
  await page.waitForSelector('.msg-assistant .msg-meta:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.conv-item').length === 2);
  assert(true, 'в списке два диалога');
  await page.hover('.conv-item.active');
  await page.click('.conv-item.active .icon-btn[title="Переименовать"]');
  await page.fill('.conv-item input', 'Асинхронность');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.conv-item.active .conv-title:has-text("Асинхронность")');
  assert(true, 'переименование');
  page.once('dialog', d => d.accept());
  await page.hover('.conv-item.active');
  await page.click('.conv-item.active .icon-btn[title="Удалить"]');
  await page.waitForFunction(() => document.querySelectorAll('.conv-item').length === 1);
  assert(await page.isVisible('#empty-state'), 'удаление открытого диалога → пустой экран');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', e => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/');
  await mobile.waitForSelector('#conn-status.is-ok');
  await mobile.waitForFunction(() => document.querySelector('.vram-text').textContent !== '—');
  // Новый профиль браузера → выбрана модель по умолчанию qwen3:8b, хотя в памяти висит qwen3:14b
  assert(await mobile.inputValue('#model-select') === 'qwen3:8b', 'в новом профиле — модель по умолчанию');
  assert(await mobile.isHidden('#banner'), 'нет предупреждения, если выбрана модель, которая влезает');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'нет горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/6-mobile.png' });
  await mobile.click('#menu-btn');
  await mobile.waitForTimeout(300);
  await mobile.screenshot({ path: OUT + '/7-mobile-sidebar.png' });

  assert(errors.length === 0, 'нет ошибок в консоли браузера' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('\nВСЕ ПРОВЕРКИ ИНТЕРФЕЙСА ПРОЙДЕНЫ');
})().catch(e => { console.error(e.message); process.exit(1); });
