// Сквозная проверка этапа 6: оценки, исправления, страница «Датасет», экспорт.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const APP = 'http://127.0.0.1:8000';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
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
const nth = (i) => `.msg-assistant >> nth=${i}`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(APP + '/');
  await page.waitForSelector('#conn-status.is-ok');
  await send(page, 'Что такое замыкание?');
  await send(page, 'Сколько планет в Солнечной системе, ответь одним числом');

  // --- 👍 ---
  await page.locator(nth(0)).locator('.btn-like').click();
  await page.waitForSelector('.msg-assistant:first-child .btn-like.active, .msg-assistant >> nth=0 >> .btn-like.active');
  assert(await page.locator(nth(0)).locator('.btn-like.active').count() === 1, '👍 подсвечен');

  // --- 👎 и исправление ---
  const second = page.locator(nth(1));
  await second.locator('.btn-dislike').click();
  await page.waitForFunction(() => document.querySelectorAll('.msg-assistant')[1].querySelector('.btn-dislike.active'));
  assert(true, '👎 подсвечен');
  await second.locator('.btn-edit').click();
  await second.locator('.correct-box textarea').waitFor();
  assert((await second.locator('.correct-box textarea').inputValue()).startsWith('Вы спросили'), 'редактор открыт с текстом исходного ответа');
  await page.screenshot({ path: OUT + '/d1-editor.png' });
  await second.locator('.correct-box textarea').fill('В Солнечной системе **8 планет**.');
  await page.keyboard.press('Control+Enter');
  await second.locator('.correction-note').waitFor();
  assert((await second.locator('.content').innerHTML()).includes('<strong>8 планет</strong>'), 'исправленный ответ показан с markdown');
  assert((await second.locator('.correction-note').textContent()).includes('Исправлено вами'), 'пометка «исправлено»');
  await second.locator('.correction-note .link-btn').click();
  assert((await second.locator('.content').textContent()).startsWith('Вы спросили'), '«показать оригинал»');
  await second.locator('.correction-note .link-btn').click();
  await page.screenshot({ path: OUT + '/d2-corrected.png' });

  // Модель видит исправление в следующем запросе
  await send(page, 'А сколько у Земли спутников?');
  const sent = (await lastRequest()).messages;
  assert(sent.some((m) => m.role === 'assistant' && m.content === 'В Солнечной системе **8 планет**.'), 'в истории для модели — исправленная версия');

  // После перезагрузки всё на месте
  await page.reload();
  await page.waitForSelector('.feedback:not([hidden])');
  assert(await page.locator(nth(0)).locator('.btn-like.active').count() === 1, '👍 сохранился после перезагрузки');
  assert(await page.locator(nth(1)).locator('.correction-note').count() === 1, 'исправление сохранилось');

  // Ответ с инструментом
  await send(page, 'Посчитай 15*15');
  await page.locator(nth(3)).locator('.btn-like').click();
  await page.waitForFunction(() => document.querySelectorAll('.msg-assistant')[3].querySelector('.btn-like.active'));

  // --- Страница «Датасет» ---
  await page.click('#dataset-btn');
  await page.waitForSelector('#dataset-view:not([hidden]) .ds-item');
  assert(page.url().endsWith('#/dataset'), 'адрес #/dataset');
  assert((await page.textContent('#ds-count')) === '2', 'в обучении 2 примера (👍 и исправленный)');
  assert((await page.$$('.ds-item')).length === 3, 'всего 3 примера');
  assert((await page.textContent('.ds-item:has-text("15*15") .ds-badge.out')).includes('инструментами'), 'ответ с инструментом — не в обучении, с объяснением');
  await page.screenshot({ path: OUT + '/d3-dataset.png' });

  // Экспорт SFT
  const sftUrl = await page.getAttribute('#ds-download', 'href');
  const sft = (await (await page.request.get(APP + sftUrl)).text()).trim().split('\n').map(JSON.parse);
  assert(sft.length === 2, 'SFT: 2 строки JSONL');
  assert(sft[1].messages.at(-1).content === 'В Солнечной системе **8 планет**.', 'SFT: исправленный ответ — образец');
  assert(sft[0].messages[0].role === 'system', 'SFT: с системным промптом');
  await page.uncheck('#ds-system');
  await page.check('input[name=ds-format][value=dpo]');
  const dpo = (await (await page.request.get(APP + (await page.getAttribute('#ds-download', 'href')))).text()).trim().split('\n').map(JSON.parse);
  assert(dpo.length === 1 && dpo[0].chosen[0].content.includes('8 планет') && dpo[0].prompt[0].role === 'user', 'DPO: пара без системного промпта');

  // Фильтры
  await page.click('.ds-filter[data-filter="corrected"]');
  await page.waitForFunction(() => document.querySelectorAll('.ds-item').length === 1);
  assert(true, 'фильтр «Исправленные»');
  await page.click('.ds-filter[data-filter="all"]');
  await page.waitForFunction(() => document.querySelectorAll('.ds-item').length === 3);

  // Исключить и вернуть
  await page.click('.ds-item:has-text("замыкание") button:has-text("Исключить")');
  await page.waitForFunction(() => document.querySelector('#ds-count').textContent === '1');
  assert(true, 'исключённый пример убран из обучения');
  await page.click('.ds-item:has-text("замыкание") button:has-text("Вернуть в датасет")');
  await page.waitForFunction(() => document.querySelector('#ds-count').textContent === '2');

  // Правка исправления на странице
  await page.click('.ds-item:has-text("планет") button:has-text("Изменить исправление")');
  await page.fill('.ds-edit textarea', 'Восемь планет: от Меркурия до Нептуна.');
  await page.click('.ds-edit .btn-primary');
  await page.waitForSelector('.ds-a.corrected:has-text("Восемь планет")');
  assert(true, 'исправление изменено со страницы датасета');

  // Удаление снимает оценку в чате
  page.once('dialog', (d) => d.accept());
  await page.click('.ds-item:has-text("замыкание") button:has-text("Удалить")');
  await page.waitForFunction(() => document.querySelectorAll('.ds-item').length === 2);
  await page.click('.ds-item:has-text("планет") .link-btn');
  await page.waitForSelector('.feedback:not([hidden])');
  assert(await page.locator(nth(0)).locator('.btn-like.active').count() === 0, 'после удаления примера 👍 в чате снят');
  assert((await page.locator(nth(1)).locator('.content').textContent()).includes('Восемь планет'), 'правка со страницы видна в чате');

  // Снять оценку повторным кликом
  await page.locator(nth(3)).locator('.btn-like').click();
  await page.waitForFunction(() => !document.querySelectorAll('.msg-assistant')[3].querySelector('.btn-like.active'));
  assert(true, 'повторный клик снимает 👍');

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(APP + '/#/dataset');
  await mobile.waitForSelector('.ds-item');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'страница датасета без горизонтальной прокрутки на телефоне');
  await mobile.screenshot({ path: OUT + '/d4-mobile.png' });

  assert(errors.length === 0, 'нет ошибок в консоли' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('\nВСЕ ПРОВЕРКИ ЭТАПА 6 ПРОЙДЕНЫ');
})().catch((e) => { console.error(e.message); process.exit(1); });
