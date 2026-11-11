// Сквозная проверка этапа 15б: 3D-модели — ```3d с вырезами (CSG), размеры, экспорт STL/OBJ/GLB,
// ошибка в коде модели → «Исправить», загрузка своего STL: описание в контекст и просмотрщик.
// Запуск: см. tests/e2e/README.md (эмулятор Ollama на :11434 и сервер на :8000 с чистой базой).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const FAKE = process.env.FAKE_OLLAMA || 'http://127.0.0.1:11434';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const lastRequest = async () => (await fetch(FAKE + '/_test/last_request')).json();
const last = '.msg-assistant:last-child';

/** Двоичный STL коробки 10 × 20 × 30 мм (Z — вверх, как у 3D-принтеров). */
function boxStl() {
  const V = [[0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0], [0, 0, 30], [10, 0, 30], [10, 20, 30], [0, 20, 30]];
  const Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = Q.flatMap((q) => [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]);
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((v, k) => V[v].forEach((c, j) => buf.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))));
  return buf;
}

async function send(page, text) {
  const before = await page.$$eval('.msg-assistant', (m) => m.length);
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => {
    const all = document.querySelectorAll('.msg-assistant');
    return all.length > n && !all[all.length - 1].querySelector('.msg-meta').hidden;
  }, before, { timeout: 20000 });
}

async function modelInfo(page) {
  await page.waitForFunction(() => document.getElementById('artifact-panel').dataset.model, null, { timeout: 20000 });
  return JSON.parse(await page.evaluate(() => document.getElementById('artifact-panel').dataset.model));
}

async function download(page, frame, label) {
  const [dl] = await Promise.all([page.waitForEvent('download'), frame.click(`button[data-kit="${label}"]`)]);
  return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => { if (!e.message.includes('undefinedPart')) errors.push(e.message); });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.startsWith('about:srcdoc')) errors.push(m.text());
  });
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-ok');

  // --- Модель с вырезами ---
  await send(page, 'Сделай 3d-модель подставки для ручек');
  assert((await page.textContent(`${last} .ac-title`)) === 'Подставка для ручек', 'карточка 3D-модели с названием из «// title:»');
  assert((await page.textContent(`${last} .ac-open`)).includes('Открыть 3D'), 'кнопка «Открыть 3D»');
  let info = await modelInfo(page);
  assert(JSON.stringify(info.size) === '[80,50,40]', `размеры 80 × 50 × 40 мм: ${JSON.stringify(info.size)}`);
  assert(info.triangles > 12, 'отверстия вырезаны (треугольников больше, чем у простой коробки)');
  const frameEl = await page.$('#ap-view iframe');
  const frame = await frameEl.contentFrame();
  assert((await frame.textContent('#kit-info')).includes('80 × 50 × 40 мм'), 'размеры видны в просмотрщике');
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/m1-model.png' });

  // --- Экспорт ---
  const stl = await download(page, frame, '⤓ STL');
  assert(stl.name === 'Подставка для ручек.stl' && stl.data.readUInt32LE(80) === info.triangles, 'STL для печати: все треугольники');
  // В STL ось Z — вверх: высота 40 мм должна оказаться по Z
  let maxZ = -Infinity, minZ = Infinity;
  for (let i = 0; i < stl.data.readUInt32LE(80); i++) for (let k = 0; k < 3; k++) {
    const z = stl.data.readFloatLE(84 + i * 50 + 12 + k * 12 + 8);
    maxZ = Math.max(maxZ, z); minZ = Math.min(minZ, z);
  }
  assert(Math.abs(maxZ - minZ - 40) < 0.01, `в STL высота по оси Z (${(maxZ - minZ).toFixed(1)} мм) — деталь стоит на столе`);
  const obj = await download(page, frame, '⤓ OBJ');
  assert(obj.name.endsWith('.obj') && obj.data.toString().includes('\nv '), 'OBJ для Blender');
  const glb = await download(page, frame, '⤓ GLB');
  assert(glb.data.subarray(0, 4).toString() === 'glTF', 'GLB');

  await page.click('#ap-tabs [data-tab=code]');
  assert((await page.textContent('#ap-code-body')).includes('subtract(body'), 'вкладка «Код» — код модели');
  await page.click('#ap-tabs [data-tab=view]');

  // --- Ошибка в коде модели ---
  await send(page, 'Сделай 3d-модель с ошибкой');
  await page.waitForSelector('#ap-bars .fix-bar.is-error');
  const err = await page.textContent('#ap-bars .fix-bar.is-error span');
  assert(err.includes('undefinedPart') && err.includes('(строка 4)'), `ошибка с номером строки кода модели: ${err}`);

  // --- Свой STL ---
  await page.click('#new-chat-btn');
  await page.setInputFiles('#attach-input', { name: 'деталь.stl', mimeType: 'model/stl', buffer: boxStl() });
  await page.waitForSelector('.attach-chip.is-ready');
  assert((await page.textContent('.attach-chip .a-info')).includes('10 × 20 × 30 мм'), 'чип: габариты модели');
  await send(page, 'Влезет на стол принтера 220×220? Сколько уйдёт пластика?');
  const q = (await lastRequest()).messages.at(-1).content;
  assert(q.includes('габариты по осям X × Y × Z = 10,0 × 20,0 × 30,0 мм') && q.includes('PLA'), 'описание модели ушло в контекст');
  await page.click('.msg-user .file-chip.is-model');
  info = await modelInfo(page);
  assert(JSON.stringify(info.size.map(Math.round)) === '[10,20,30]', `просмотрщик: 10 × 20 × 30, высота по Z: ${JSON.stringify(info.size)}`);
  assert(await page.isHidden('#ap-tabs [data-tab=code]'), 'у файла модели нет вкладки «Код»');
  await page.screenshot({ path: OUT + '/m2-upload.png' });

  // --- Телефон ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(page.url());
  await mobile.waitForSelector('.file-chip.is-model');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'телефон: нет горизонтальной прокрутки');

  assert(errors.length === 0, 'нет ошибок в консоли: ' + JSON.stringify(errors));
  await browser.close();
  console.log('ВСЕ ПРОВЕРКИ ЭТАПА 15б ПРОЙДЕНЫ');
})().catch((e) => { console.error(e); process.exit(1); });
