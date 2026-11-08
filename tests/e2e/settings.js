// Сквозная проверка этапа 2: персоны, настройки, оценка VRAM.
// Запуск: см. tests/e2e/README.md (нужны эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
// toLocaleString('ru-RU') разделяет тысячи неразрывным пробелом — приводим к обычному
const norm = (t) => t.replace(/\u00a0|\u202f/g, ' ');
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };

// Что последним ушло в модель (служебный адрес эмулятора)
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');
  await page.waitForFunction(() => document.querySelectorAll('#persona-select option').length >= 4);

  // --- Персона в верхней панели ---
  const personas = await page.$$eval('#persona-select option', (o) => o.map((x) => x.textContent));
  console.log('  персоны:', personas);
  assert(personas[0] === '🤖 Универсальный', 'по умолчанию «Универсальный»');
  await page.selectOption('#persona-select', { label: '💻 Программист' });
  await send(page, 'Почему var в цикле выводит 3 3 3?');
  let req = await lastRequest();
  assert(req.messages[0].content.includes('опытного разработчика'), 'инструкция программиста ушла в модель');
  assert(req.options.temperature === 0.3, 'температура программиста 0.3');
  assert((await page.textContent('.msg-assistant .meta-text')).startsWith('💻 Программист'), 'персона подписана под ответом');

  // --- Смена персоны посреди диалога + сохранение после перезагрузки ---
  await page.selectOption('#persona-select', { label: '🎓 Учитель' });
  await page.waitForTimeout(200);
  await send(page, 'Объясни замыкания');
  req = await lastRequest();
  assert(req.messages[0].content.includes('преподавателя'), 'после смены — инструкция учителя');
  await page.reload();
  await page.waitForSelector('.msg-assistant');
  await page.waitForFunction(() => document.querySelector('#persona-select').selectedOptions[0]?.textContent === '🎓 Учитель');
  assert(true, 'персона диалога восстановилась после перезагрузки');
  const metas = await page.$$eval('.msg-assistant .meta-text', (m) => m.map((x) => x.textContent.split(' · ')[0]));
  assert(metas.join('|') === '💻 Программист|🎓 Учитель', 'каждый ответ подписан своей персоной');

  // --- Новый чат → персона по умолчанию ---
  await page.click('#new-chat-btn');
  assert((await page.$eval('#persona-select', (s) => s.selectedOptions[0].textContent)) === '🤖 Универсальный', 'новый чат — персона по умолчанию');

  // --- Настройки: основное ---
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-dialog[open]');
  assert(await page.inputValue('#set-name') === 'Джарвис', 'имя в настройках');
  assert((await page.inputValue('#set-prompt')).startsWith('Тебя зовут {name}'), 'системный промпт загружен');
  await page.waitForFunction(() => document.querySelector('#est-message').textContent.length > 0);
  assert(await page.isVisible('#vram-estimate.is-ok'), '8K: оценка зелёная');
  assert(norm(await page.textContent('#est-safe')).includes('12 288'), 'безопасный максимум 12 288');
  assert(norm(await page.textContent('#set-ctx-value')).startsWith('8 192 токенов'), 'подпись контекста');
  await page.screenshot({ path: OUT + '/s1-settings-ok.png' });

  // 16K без сжатия → впритык; 24K → не влезет; со сжатием q8_0 16K → ок
  await page.$eval('#set-ctx', (el) => { el.value = 4; el.dispatchEvent(new Event('input')); });
  await page.waitForSelector('#vram-estimate.is-warn');
  assert(true, '16K без сжатия — впритык (жёлтый)');
  await page.screenshot({ path: OUT + '/s2-settings-warn.png' });
  await page.$eval('#set-ctx', (el) => { el.value = 5; el.dispatchEvent(new Event('input')); });
  await page.waitForSelector('#vram-estimate.is-danger');
  assert(true, '24K без сжатия — не влезет (красный)');
  await page.screenshot({ path: OUT + '/s3-settings-danger.png' });
  await page.selectOption('#set-kv', 'q8_0');
  await page.waitForSelector('#vram-estimate.is-ok');
  assert(true, '24K со сжатием q8_0 — помещается');
  await page.$eval('#set-ctx', (el) => { el.value = 3; el.dispatchEvent(new Event('input')); }); // 12K
  await page.selectOption('#set-kv', 'f16');

  // Меняем имя и промпт, сохраняем
  await page.fill('#set-name', 'Пятница');
  await page.fill('#set-prompt', 'Ты {name}. Отвечай кратко. Модель: {model}.');
  await page.click('#general-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#assistant-name').textContent === 'Пятница');
  assert((await page.title()) === 'Пятница', 'новое имя применилось без перезагрузки');
  await send(page, 'Кто ты?');
  req = await lastRequest();
  // После промпта идут правила инструментов (этап 5) — проверяем начало
  assert(req.messages[0].content.startsWith('Ты Пятница. Отвечай кратко. Модель: qwen3:8b.'), 'новый системный промпт с подстановками');
  assert(req.options.num_ctx === 12288, 'контекст 12K ушёл в Ollama');

  // «Вернуть исходный» промпт
  await page.click('#settings-btn');
  await page.click('#set-prompt-reset');
  assert((await page.inputValue('#set-prompt')).startsWith('Тебя зовут {name}'), 'кнопка «Вернуть исходный»');
  await page.fill('#set-name', 'Джарвис');
  await page.click('#general-form button[type=submit]');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });

  // --- Настройки: персоны ---
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=personas]');
  await page.waitForSelector('.persona-item.active');
  assert(await page.inputValue('#p-name') === 'Универсальный', 'открылась первая персона');
  assert(await page.isHidden('#p-delete') && await page.isVisible('#p-reset'), 'встроенную нельзя удалить, можно сбросить');
  await page.screenshot({ path: OUT + '/s4-personas.png' });

  // Своя персона
  await page.click('.persona-add');
  await page.fill('#p-icon', '🌍');
  await page.fill('#p-name', 'Переводчик');
  await page.fill('#p-description', 'Переводит на английский');
  await page.fill('#p-prompt', 'Переводи всё, что пишет пользователь, на английский.');
  await page.$eval('#p-temperature', (el) => { el.value = 0.2; el.dispatchEvent(new Event('input')); });
  assert((await page.textContent('#p-temperature-value')) === '0.20', 'подпись ползунка обновляется');
  await page.click('#persona-form button[type=submit]');
  await page.waitForSelector('.persona-item.active:has-text("Переводчик")');
  assert(await page.isVisible('#p-delete'), 'у своей персоны есть «Удалить»');
  await page.waitForFunction(() => [...document.querySelectorAll('#persona-select option')].some((o) => o.textContent === '🌍 Переводчик'));
  assert(true, 'новая персона появилась в верхней панели');

  // Изменить встроенного учителя и сбросить
  await page.click('.persona-item:has-text("Учитель")');
  await page.$eval('#p-temperature', (el) => { el.value = 1.5; el.dispatchEvent(new Event('input')); });
  await page.click('#persona-form button[type=submit]');
  await page.waitForTimeout(300);
  page.once('dialog', (d) => d.accept());
  await page.click('#p-reset');
  await page.waitForFunction(() => document.querySelector('#p-temperature-value').textContent === '0.70');
  assert(true, 'встроенная персона сброшена к исходной');

  // Ошибка валидации
  await page.click('.persona-item:has-text("Переводчик")');
  await page.fill('#p-name', '');
  await page.click('#persona-form button[type=submit]');
  assert(await page.isVisible('#persona-error'), 'пустое название — ошибка');
  await page.fill('#p-name', 'Переводчик');

  await page.keyboard.press('Escape');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });

  // Чат с новой персоной
  await page.click('#new-chat-btn');
  await page.selectOption('#persona-select', { label: '🌍 Переводчик' });
  await send(page, 'Привет, мир');
  req = await lastRequest();
  assert(req.options.temperature === 0.2 && req.messages[0].content.includes('на английский'), 'своя персона работает');

  // Удаление своей персоны
  await page.click('#settings-btn');
  await page.click('.tab[data-tab=personas]');
  await page.click('.persona-item:has-text("Переводчик")');
  page.once('dialog', (d) => d.accept());
  await page.click('#p-delete');
  await page.waitForFunction(() => ![...document.querySelectorAll('.persona-item')].some((i) => i.textContent.includes('Переводчик')));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => ![...document.querySelectorAll('#persona-select option')].some((o) => o.textContent.includes('Переводчик')));
  assert((await page.$eval('#persona-select', (s) => s.selectedOptions[0].textContent)) === '🤖 Универсальный', 'после удаления диалог перешёл на персону по умолчанию');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.1:8000/');
  await mobile.waitForSelector('#conn-status.is-ok');
  await mobile.screenshot({ path: OUT + '/s5-mobile-topbar.png' });
  await mobile.click('#menu-btn');
  await mobile.click('#settings-btn');
  await mobile.waitForSelector('#settings-dialog[open]');
  await mobile.waitForFunction(() => document.querySelector('#est-message').textContent.length > 0);
  const overflow = await mobile.evaluate(() => document.querySelector('#settings-dialog').scrollWidth > window.innerWidth);
  assert(!overflow, 'окно настроек без горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/s6-mobile-settings.png' });
  await mobile.click('.tab[data-tab=personas]');
  await mobile.waitForSelector('.persona-item.active');
  await mobile.screenshot({ path: OUT + '/s7-mobile-personas.png' });

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 2 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
