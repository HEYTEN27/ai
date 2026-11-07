// Ollama выключена: интерфейс должен объяснить, что делать, и не падать
const { chromium } = require('playwright');
require('fs').mkdirSync(require('path').join(__dirname, 'screenshots'), { recursive: true });
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForSelector('#conn-status.is-error');
  assert((await page.textContent('.conn-text')) === 'Ollama недоступна', 'статус: Ollama недоступна');
  await page.waitForSelector('#banner.is-error:not([hidden])');
  const text = await page.textContent('#banner');
  assert(text.includes('ollama serve'), 'плашка подсказывает, как запустить Ollama');
  await page.screenshot({ path: require('path').join(__dirname, 'screenshots', '8-ollama-down.png') });
  assert(errors.length === 0, 'нет JS-ошибок' + errors.join('|'));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
