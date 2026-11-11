// =====================================================================
// Артефакты (этап 10): игры, интерактивные страницы, схемы и рисунки.
//
// Модель пишет обычный блок кода ```html / ```svg / ```mermaid. Здесь мы:
//   * заменяем такой блок в чате карточкой «▶ Открыть» (схема и рисунок видны сразу);
//   * запускаем HTML в панели справа — в ПЕСОЧНИЦЕ: iframe без доступа к приложению
//     (sandbox без allow-same-origin) и без сети (Content-Security-Policy);
//   * ловим ошибки внутри игры и даём одной кнопкой попросить Джарвиса их исправить;
//   * считаем каждую новую версию с тем же названием версией одного артефакта.
//
// Почему песочница важна: код пишет модель, и он мог бы, например, отправить запрос
// к нашему серверу и удалить диалоги. В iframe с sandbox у страницы «чужой» источник,
// а CSP запрещает любые сетевые запросы — даже в интернет (всё работает офлайн).
// =====================================================================

/* global hljs, mermaid */

const $ = (id) => document.getElementById(id);

const HTML_DOCUMENT = /<!doctype|<html|<body|<canvas|<script/i;

// Библиотеки, которые лежат локально и подставляются вместо CDN-ссылок
const LIBS = [
  // Дополнения Three.js (управление камерой, экспорт, загрузчики) — раньше ядра: в их адресе тоже есть «three@»
  { name: "Three.js (дополнения)", file: "three-addons.js",
    match: /three-addons\.js$|examples\/js\/(controls|loaders|exporters)\/|OrbitControls\.js|(STL|OBJ|GLTF)(Loader|Exporter)\.js/i },
  { name: "Набор 3D", file: "kit3d.js", match: /kit3d\.js$/i },
  { name: "Three.js", file: "three.min.js", match: /three(\.module)?(\.min)?\.js(\?.*)?$|three@|\/three\.js\/|three\/build/i },
  { name: "Chart.js", file: "chart.umd.js", match: /chart(\.umd)?(\.min)?\.js(\?.*)?$|chart\.js@|\/chart\.js\//i },
];
const libCache = new Map();

// Политика безопасности внутри артефакта: только встроенные скрипты и стили, никакой сети
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src blob:; " +
  "form-action 'none'; base-uri 'none'";

let fixHandler = () => {};
/** app.js передаёт сюда функцию «отправить сообщение» — для кнопки «Исправить». */
export function setFixHandler(fn) {
  fixHandler = fn;
}

// ---------- распознавание ----------

export function artifactTitle(lang, code) {
  if (lang === "3d") {
    // Первая строка модели: «// title: Держатель для телефона»
    const m = code.match(/^\s*\/\/\s*(?:title|название)\s*:\s*(.{1,120})$/im);
    return m ? m[1].trim() : "3D-модель";
  }
  if (lang === "html" || lang === "svg") {
    const m = code.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    if (m && m[1].trim()) return m[1].trim();
    return lang === "html" ? "Страница" : "Рисунок";
  }
  return "Схема";
}

function isArtifact(lang, code) {
  if (lang === "3d") return code.trim().length > 0;
  if (lang === "html") return HTML_DOCUMENT.test(code);
  if (lang === "svg") return code.toLowerCase().includes("<svg");
  return lang === "mermaid" && code.trim().length > 0;
}

const KIND = {
  html: { icon: "🎮", label: "HTML", open: "▶ Запустить", ext: "html", mime: "text/html" },
  svg: { icon: "🖼️", label: "SVG", open: "Открыть", ext: "svg", mime: "image/svg+xml" },
  mermaid: { icon: "🧭", label: "Схема Mermaid", open: "Открыть", ext: "svg", mime: "image/svg+xml" },
  "3d": { icon: "🧊", label: "3D-модель", open: "▶ Открыть 3D", ext: "js", mime: "text/javascript" },
  model: { icon: "🧊", label: "Файл 3D-модели", open: "▶ Открыть 3D", ext: "", mime: "" },
};

function lineCount(code) {
  return code.split("\n").length;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
}

/**
 * Находит блоки-артефакты в отрисованном ответе и заменяет их карточками.
 * raw — исходный markdown (по нему видно, что последний блок кода не закрыт = ответ оборвался).
 */
export function enhanceArtifacts(container, { raw = "", streaming = false } = {}) {
  const fences = (raw.match(/^\s*```/gm) || []).length;
  const unclosed = fences % 2 === 1;
  const blocks = [...container.querySelectorAll("pre > code")].filter((code) => {
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9).toLowerCase();
    return lang && isArtifact(lang, code.textContent);
  });
  blocks.forEach((codeEl, i) => {
    const lang = [...codeEl.classList].find((c) => c.startsWith("language-")).slice(9).toLowerCase();
    const code = codeEl.textContent.replace(/\n$/, "");
    const isLast = i === blocks.length - 1;
    const writing = streaming && isLast && unclosed; // модель ещё пишет этот блок
    const truncated = !streaming && isLast && unclosed; // ответ закончился посреди кода
    const art = { lang, code, title: artifactTitle(lang, code), truncated };
    art.key = `${lang}:${art.title.toLowerCase()}`;
    codeEl.parentElement.replaceWith(buildCard(art, writing));
  });
}

function buildCard(art, writing) {
  const kind = KIND[art.lang];
  const card = document.createElement("div");
  card.className = `artifact-card kind-${art.lang}` + (writing ? " is-writing" : "") + (art.truncated ? " is-truncated" : "");
  card.dataset.key = art.key;
  card.artifact = art; // данные храним прямо на элементе — панель найдёт все версии по DOM
  // Ответ перерисовывается (например, после оценки) — открытая в панели карточка остаётся подсвеченной
  if (!writing && current && current.art.key === art.key && current.art.code === art.code) card.classList.add("is-open");

  const head = document.createElement("div");
  head.className = "ac-head";
  const icon = document.createElement("span");
  icon.className = "ac-icon";
  icon.textContent = kind.icon;
  const text = document.createElement("div");
  text.className = "ac-text";
  const title = document.createElement("span");
  title.className = "ac-title";
  title.textContent = art.title;
  const sub = document.createElement("span");
  sub.className = "ac-sub";
  sub.textContent = writing ? `пишу код… ${plural(lineCount(art.code), "строка", "строки", "строк")}`
    : art.truncated ? "⚠ код оборвался — не хватило места в контексте"
      : `${kind.label} · ${plural(lineCount(art.code), "строка", "строки", "строк")}`;
  text.append(title, sub);
  head.append(icon, text);
  if (!writing) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ac-open";
    btn.textContent = kind.open;
    btn.addEventListener("click", () => openArtifact(card));
    head.append(btn);
  }
  card.append(head);

  // Рисунок и схему показываем прямо в чате
  if (!writing && art.lang === "svg") {
    const img = document.createElement("img");
    img.className = "ac-preview";
    img.alt = art.title;
    img.src = svgDataUrl(art.code);
    img.addEventListener("click", () => openArtifact(card));
    card.append(img);
  }
  if (!writing && art.lang === "mermaid") {
    const box = document.createElement("div");
    box.className = "ac-preview ac-mermaid";
    box.textContent = "Рисую схему…";
    card.append(box);
    renderMermaid(art.code).then((svg) => {
      box.innerHTML = svg;
      box.addEventListener("click", () => openArtifact(card));
    }).catch((e) => {
      box.classList.add("is-error");
      box.textContent = "";
      box.append(fixBar(`Ошибка в схеме: ${e.message}`,
        `В схеме Mermaid «${art.title}» ошибка синтаксиса: ${e.message}. Исправь и пришли схему целиком.`));
    });
  }
  return card;
}

/** SVG как картинка: в <img> скрипты внутри SVG не выполняются — так безопасно. */
function svgDataUrl(code) {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(code);
}

function fixBar(text, request) {
  const bar = document.createElement("div");
  bar.className = "fix-bar";
  const span = document.createElement("span");
  span.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-small fix-btn";
  btn.textContent = "🛠 Исправить";
  btn.title = "Попросить Джарвиса исправить";
  btn.addEventListener("click", () => fixHandler(request));
  bar.append(span, btn);
  return bar;
}

// ---------- Mermaid (загружается только когда нужен: библиотека весит 3 МБ) ----------

let mermaidReady = null;
const mermaidCache = new Map();
let mermaidCounter = 0;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`не загрузилась ${src}`));
    document.head.append(s);
  });
}

function mermaidTheme() {
  const hud = document.documentElement.dataset.theme === "hud";
  return hud
    ? { theme: "base", themeVariables: { background: "transparent", primaryColor: "#0b2a3a", primaryTextColor: "#e6f7ff",
      primaryBorderColor: "#3fd9ff", lineColor: "#3fd9ff", secondaryColor: "#12324a", tertiaryColor: "#081a28",
      fontFamily: "Exo 2, sans-serif", textColor: "#cfefff", edgeLabelBackground: "#061420" } }
    : { theme: "dark" };
}

async function renderMermaid(code) {
  const theme = document.documentElement.dataset.theme || "hud";
  const cacheKey = theme + "\n" + code;
  if (mermaidCache.has(cacheKey)) return mermaidCache.get(cacheKey);
  mermaidReady ??= loadScript("/vendor/mermaid.min.js");
  await mermaidReady;
  // strict: Mermaid сам вычищает HTML из подписей — модель не сможет «подсунуть» скрипт
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", ...mermaidTheme() });
  const id = `mmd-${++mermaidCounter}`;
  try {
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    mermaidCache.set(cacheKey, svg);
    return svg;
  } finally {
    document.getElementById(id)?.remove(); // при ошибке Mermaid оставляет служебный элемент в body
    document.getElementById(`d${id}`)?.remove();
  }
}

// ---------- подготовка HTML к запуску ----------

async function libText(file) {
  if (!libCache.has(file)) {
    libCache.set(file, fetch(`/vendor/artifact-libs/${file}`).then((r) => {
      if (!r.ok) throw new Error(`нет файла ${file}`);
      return r.text();
    }));
  }
  return libCache.get(file);
}

/**
 * Собирает документ для iframe: CSP + перехват ошибок + локальные библиотеки.
 * Вставку делаем сразу после <head> одной «пачкой», чтобы номера строк в ошибках можно было
 * пересчитать обратно в строки кода модели: всё, что ниже вставки, сдвинуто на `added` строк.
 */
export async function buildSrcdoc(code, token) {
  const notes = [];
  const libs = [];
  // Внешние <script src> известных библиотек убираем — подключим локальную копию
  let html = code.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    const lib = LIBS.find((l) => l.match.test(src));
    if (lib) {
      if (!libs.includes(lib)) libs.push(lib);
      return "<!-- " + lib.name + " подключена локально -->" + "\n".repeat((tag.match(/\n/g) || []).length);
    }
    if (/^(https?:)?\/\//i.test(src)) notes.push(`Внешний скрипт недоступен офлайн: ${src}`);
    return tag;
  });

  const reporter = `<script>(function(){var T=${JSON.stringify(token)};` +
    "function s(d){d.__artifact=T;try{parent.postMessage(d,'*')}catch(e){}}" +
    "window.addEventListener('error',function(e){s({type:'error',message:String(e.message||e),line:e.lineno||0})});" +
    "window.addEventListener('unhandledrejection',function(e){var r=e.reason;s({type:'error',message:'Promise: '+(r&&r.message||r),line:0})});" +
    "document.addEventListener('securitypolicyviolation',function(e){s({type:'blocked',url:String(e.blockedURI||''),directive:e.violatedDirective})});" +
    "window.addEventListener('load',function(){s({type:'ready'})});" +
    "window.__artifactSend=s;window.__artifactToken=T;" + // для 3D-набора: скачивание файлов и приём модели
    "})();</script>";
  let injected = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8">${reporter}`;
  for (const lib of libs) injected += `<script>${await libText(lib.file)}\n</script>`;

  // Куда вставлять: после <head>, иначе после <html>, иначе после <!DOCTYPE>, иначе в начало
  const anchor = html.match(/<head\b[^>]*>/i) || html.match(/<html\b[^>]*>/i) || html.match(/<!doctype[^>]*>/i);
  const at = anchor ? anchor.index + anchor[0].length : 0;
  const line = html.slice(0, at).split("\n").length; // строка, где вставка
  const added = (injected.match(/\n/g) || []).length;
  html = html.slice(0, at) + injected + html.slice(at);
  return { html, notes, libs: libs.map((l) => l.name), lineMap: (l) => (l > line + added ? l - added : l > line ? null : l) };
}

// =====================================================================
// Панель
// =====================================================================

const panel = () => $("artifact-panel");
let current = null; // { art, card } открытый артефакт
let runToken = null;
let runInfo = null; // lineMap текущего запуска
let errorsShown = 0;

function versionsOf(key) {
  return [...document.querySelectorAll("#messages .artifact-card")].filter((c) => c.dataset.key === key && c.artifact);
}

/** Открыть артефакт карточки в панели. */
export function openArtifact(card) {
  openArt(card.artifact, card);
}

/** Открыть свой файл 3D-модели (STL/OBJ/GLB из вложений) в просмотрщике. */
export function openModelFile(file) {
  openArt({ lang: "model", title: file.name, code: "", key: `model:${file.id}`, file, truncated: false }, null);
}

function openArt(art, card) {
  const versions = versionsOf(art.key);
  current = { art, index: Math.max(0, versions.indexOf(card)) };
  document.querySelectorAll(".artifact-card.is-open").forEach((c) => c.classList.remove("is-open"));
  card?.classList.add("is-open");
  document.body.classList.add("artifact-open");
  panel().hidden = false;

  $("ap-title").textContent = art.title;
  $("ap-kind").textContent = KIND[art.lang].label;
  const select = $("ap-version");
  select.innerHTML = "";
  versions.forEach((_, i) => select.append(new Option(`Версия ${i + 1}`, String(i))));
  select.value = String(current.index);
  select.hidden = versions.length < 2;

  // У файла модели нет «кода» — только просмотр
  $("ap-tabs").querySelector("[data-tab=code]").hidden = art.lang === "model";
  $("ap-download").hidden = art.lang === "model";
  showTab(art.lang === "model" ? "view" : $("ap-tabs").dataset.tab || "view");
  $("ap-restart").hidden = !["html", "3d", "model"].includes(art.lang);
}

function showTab(tab) {
  $("ap-tabs").dataset.tab = tab;
  $("ap-tabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("ap-view").hidden = tab !== "view";
  $("ap-code").hidden = tab !== "code";
  if (tab === "code") renderCode();
  else renderView();
}

function renderCode() {
  const code = $("ap-code-body");
  code.textContent = current.art.code;
  code.className = current.art.lang === "mermaid" ? "language-plaintext"
    : current.art.lang === "3d" ? "language-javascript" : "language-xml";
  delete code.dataset.highlighted;
  if (typeof hljs !== "undefined" && current.art.code.length < 200_000) hljs.highlightElement(code);
}

async function renderView() {
  const view = $("ap-view");
  const { art } = current;
  stopRun();
  view.innerHTML = "";
  delete panel().dataset.model; // размеры прошлой 3D-модели больше не актуальны
  clearBars();
  errorsShown = 0;
  if (art.truncated) {
    addBar("warn", "Код оборвался: модели не хватило места в контексте, поэтому игра может не работать. " +
      "Увеличьте размер контекста в ⚙ → «Основное» (16K вместе со сжатием KV-кэша q8_0) или попросите сделать проще.");
  }
  if (art.lang === "svg") {
    const img = document.createElement("img");
    img.className = "ap-image";
    img.alt = art.title;
    img.src = svgDataUrl(art.code);
    view.append(img);
    return;
  }
  if (art.lang === "mermaid") {
    const box = document.createElement("div");
    box.className = "ap-mermaid";
    view.append(box);
    try {
      box.innerHTML = await renderMermaid(art.code);
    } catch (e) {
      addBar("error", `Ошибка в схеме: ${e.message}`,
        `В схеме Mermaid «${art.title}» ошибка синтаксиса: ${e.message}. Исправь и пришли схему целиком.`);
    }
    return;
  }
  // HTML, 3D-модель, файл модели — в песочнице
  runToken = Math.random().toString(36).slice(2);
  const page = art.lang === "3d" ? make3dPage(art) : art.lang === "model" ? makeModelPage(art) : { html: art.code, offset: 0 };
  const built = await buildSrcdoc(page.html, runToken);
  runInfo = { ...built, offset: page.offset };
  for (const note of built.notes) addBar("warn", note);
  const frame = document.createElement("iframe");
  frame.className = "ap-frame";
  frame.title = art.title;
  // allow-scripts — без него не работает JS; allow-same-origin НЕ даём — так страница изолирована
  frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock allow-modals");
  frame.setAttribute("allow", "fullscreen");
  frame.srcdoc = built.html;
  view.append(frame);
  frame.addEventListener("load", () => frame.focus()); // чтобы игра сразу слушала клавиатуру
}

function stopRun() {
  runToken = null;
  $("ap-view").querySelector("iframe")?.remove(); // удаление iframe останавливает игру и звук
}

function clearBars() {
  $("ap-bars").innerHTML = "";
}

function addBar(level, text, fixRequest) {
  const bar = fixRequest ? fixBar(text, fixRequest) : document.createElement("div");
  if (!fixRequest) {
    bar.className = "fix-bar";
    bar.textContent = text;
  }
  bar.classList.add(`is-${level}`);
  $("ap-bars").append(bar);
}

// ---------- 3D (этап 15б) ----------

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Страница 3D-модели: Three.js + дополнения + наш набор (kit3d.js), затем код модели и «показать».
 * offset — сколько строк обёртки стоит перед кодом модели: ошибку «строка 25 страницы»
 * пересчитываем в «строка 3 кода модели».
 */
function make3dPage(art) {
  const head = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(art.title)}</title></head><body>\n` +
    `<script src="three.js"></script>\n<script src="three-addons.js"></script>\n<script src="kit3d.js"></script>\n<script>\n`;
  // Код модели в отдельном <script>: если он упадёт, следующий скрипт всё равно покажет, что успело построиться
  const html = head + art.code.replace(/<\/script/gi, "<\\/script") + "\n</script>\n<script>window.__kitFinish()</script>\n</body></html>";
  return { html, offset: (head.match(/\n/g) || []).length };
}

/** Просмотрщик своего файла: набор ждёт, пока родитель передаст байты файла (сеть в песочнице закрыта). */
function makeModelPage(art) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(art.title.replace(/\.[^.]+$/, ""))}</title></head><body>\n` +
    `<script src="three.js"></script>\n<script src="three-addons.js"></script>\n<script src="kit3d.js"></script>\n` +
    "<script>window.__kitWaitFile()</script>\n</body></html>";
  return { html, offset: 0 };
}

async function sendModelFile(frame) {
  const file = current?.art.file;
  if (!file) return;
  const format = file.meta?.format || file.name.split(".").pop().toLowerCase();
  try {
    const buffer = await (await fetch(file.url)).arrayBuffer();
    frame.contentWindow.postMessage({ __kitFile: runToken, format, buffer }, "*", [buffer]);
  } catch (e) {
    addBar("error", `Не удалось загрузить файл: ${e.message}`);
  }
}

/** Скачивание из песочницы (STL/OBJ/GLB): у изолированной страницы нет права скачивать — делаем это мы. */
function saveFromSandbox(d) {
  const name = String(d.name || "model").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
  const blob = new Blob([d.data], { type: d.mime || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Сообщения из песочницы: ошибки, заблокированные запросы, «загрузилось»
window.addEventListener("message", (e) => {
  const frame = $("ap-view")?.querySelector("iframe");
  const d = e.data;
  if (!frame || e.source !== frame.contentWindow || !d || d.__artifact !== runToken || !current) return;
  if (d.type === "ready") {
    panel().dataset.state = "ready";
  } else if (d.type === "download") {
    saveFromSandbox(d);
  } else if (d.type === "need-file") {
    sendModelFile(frame);
  } else if (d.type === "model3d") {
    panel().dataset.model = JSON.stringify({ size: d.size, triangles: d.triangles }); // для тестов и подсказок
  } else if (d.type === "error" && errorsShown < 3) {
    errorsShown++;
    let line = d.line ? runInfo.lineMap(d.line) : 0;
    if (line && runInfo.offset) line = line > runInfo.offset ? line - runInfo.offset : null; // строка в коде модели
    const where = d.line ? (line === null ? " (в подключённой библиотеке)" : ` (строка ${line})`) : "";
    const version = versionsOf(current.art.key).length > 1 ? ` (версия ${current.index + 1})` : "";
    addBar("error", `Ошибка: ${d.message}${where}`,
      `В «${current.art.title}»${version} ошибка: ${d.message}${where}. Найди причину, исправь и пришли полный исправленный код.`);
  } else if (d.type === "blocked" && d.url && !/^(data|blob|inline|eval)/.test(d.url)) {
    if ($("ap-bars").textContent.includes(d.url)) return;
    addBar("warn", `Заблокирован выход в сеть: ${d.url} — артефакты работают без интернета.`);
  }
});

export function closeArtifact() {
  stopRun();
  current = null;
  panel().hidden = true;
  document.body.classList.remove("artifact-open");
  document.querySelectorAll(".artifact-card.is-open").forEach((c) => c.classList.remove("is-open"));
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export function isArtifactOpen() {
  return !panel().hidden;
}

/** После ответа: если в нём новый артефакт — открыть (на широком экране, чтобы не закрыть чат на телефоне). */
export function autoOpen(messageEl) {
  const cards = messageEl.querySelectorAll(".artifact-card");
  const last = cards[cards.length - 1];
  if (last && matchMedia("(min-width: 1000px)").matches) openArtifact(last);
}

async function download() {
  const { art } = current;
  let content = art.code;
  if (art.lang === "mermaid") {
    try {
      content = await renderMermaid(art.code);
    } catch {
      return;
    }
  }
  const blob = new Blob([content], { type: KIND[art.lang].mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${art.title.replace(/[\\/:*?"<>|]+/g, "_")}.${KIND[art.lang].ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function initArtifacts() {
  $("ap-close").addEventListener("click", closeArtifact);
  $("ap-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest("button")?.dataset.tab;
    if (tab && current) showTab(tab);
  });
  $("ap-version").addEventListener("change", (e) => {
    const card = versionsOf(current.art.key)[Number(e.target.value)];
    if (card) {
      openArtifact(card);
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  $("ap-restart").addEventListener("click", () => current && showTab("view"));
  $("ap-download").addEventListener("click", () => current && download());
  $("ap-copy").addEventListener("click", (e) => {
    if (!current) return;
    navigator.clipboard?.writeText(current.art.code).catch(() => {});
    e.currentTarget.title = "Скопировано";
  });
  $("ap-fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else panel().requestFullscreen?.().catch(() => {});
  });

  // Ширину панели можно менять, потянув за левый край; запоминаем её
  const resizer = $("ap-resizer");
  try {
    const saved = Number(localStorage.getItem("artifact_width"));
    if (saved) document.documentElement.style.setProperty("--ap-width", `${saved}px`);
  } catch {
    /* хранилище недоступно — ширина по умолчанию */
  }
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    panel().classList.add("resizing"); // iframe не должен перехватывать мышь во время перетаскивания
    const move = (ev) => {
      const width = Math.min(window.innerWidth * 0.75, Math.max(360, window.innerWidth - ev.clientX));
      document.documentElement.style.setProperty("--ap-width", `${Math.round(width)}px`);
    };
    const up = () => {
      panel().classList.remove("resizing");
      resizer.removeEventListener("pointermove", move);
      try {
        localStorage.setItem("artifact_width", parseInt(getComputedStyle(document.documentElement).getPropertyValue("--ap-width"), 10));
      } catch {
        /* не страшно */
      }
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
  });
}
