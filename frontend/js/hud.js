// =====================================================================
// Голографический интерфейс (тема «HUD»): «ядро» ассистента, приветствие
// по времени суток, часы, состояния ядра (думает / говорит / слушает).
//
// Тема — это атрибут <html data-theme="hud | classic">. Все стили HUD лежат
// в css/hud.css и включаются только при data-theme="hud", поэтому классическая
// тема остаётся нетронутой.
// =====================================================================

const $ = (id) => document.getElementById(id);
let coreCounter = 0;
let identity = { name: "Джарвис", address: "сэр" };

/**
 * «Ядро» — светящееся кольцо из вращающихся сегментов (оригинальный рисунок в духе
 * фантастического HUD). Возвращает SVG-разметку. size — «mini» | «big» | «boot».
 */
export function coreSVG(size = "big") {
  const id = `coreGlow${++coreCounter}`; // у каждого ядра свой градиент — id в документе не должны повторяться
  const notches = [0, 120, 240]
    .map((a) => `<polygon points="0,-77 -4,-70 4,-70" transform="rotate(${a})" class="notch"/>`)
    .join("");
  return `
    <svg class="core core-${size}" viewBox="-100 -100 200 200" aria-hidden="true">
      <defs>
        <radialGradient id="${id}">
          <stop offset="0%" stop-color="#f2feff"/>
          <stop offset="28%" stop-color="#8eeaff"/>
          <stop offset="55%" stop-color="rgba(40,190,255,.45)"/>
          <stop offset="100%" stop-color="rgba(40,190,255,0)"/>
        </radialGradient>
      </defs>
      <circle r="97" class="ring r-outer"/>
      <circle r="88" class="ring r-thin"/>
      <g class="r-mid"><circle r="76" class="ring r-mid-arc"/>${notches}</g>
      <circle r="62" class="ring r-ticks"/>
      <circle r="49" class="ring r-inner"/>
      <circle r="40" class="ring r-inner2"/>
      <circle r="34" fill="url(#${id})" class="core-glow"/>
      <circle r="13" class="core-dot"/>
    </svg>`;
}

/** Вставляет ядра в места с атрибутом data-core-slot="mini|big" (не путать с body[data-core] — состоянием). */
export function mountCores(root = document) {
  root.querySelectorAll("[data-core-slot]:not([data-mounted])").forEach((slot) => {
    slot.innerHTML = coreSVG(slot.dataset.coreSlot);
    slot.dataset.mounted = "1";
  });
}

/** Состояние ядра: idle | thinking | speaking | listening — меняет скорость вращения и свечение. */
export function setCoreState(state) {
  document.body.dataset.core = state;
}

export function currentTheme() {
  return document.documentElement.dataset.theme || "hud";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("ui_theme", theme); // чтобы при следующей загрузке тема была сразу, без «мигания»
  } catch {
    /* приватный режим — не страшно */
  }
  renderGreeting(false);
}

/** «Доброе утро / день / вечер / Доброй ночи» — по часам компьютера. */
export function timeGreeting(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "Доброе утро";
  if (h >= 12 && h < 18) return "Добрый день";
  if (h >= 18 && h < 23) return "Добрый вечер";
  return "Доброй ночи";
}

export function setIdentity({ name, address }) {
  identity = { name: name || identity.name, address: address || identity.address };
  // Подпись над ответами ассистента в HUD берётся из CSS-переменной
  document.documentElement.style.setProperty("--assistant-label", JSON.stringify(identity.name.toUpperCase()));
  renderGreeting(false);
}

export function getIdentity() {
  return identity;
}

let typingTimer = null;

/** Приветствие на пустом экране. В HUD — с эффектом печати. */
export function renderGreeting(animate = true) {
  const h1 = $("greeting");
  const sub = $("greeting-sub");
  if (!h1) return;
  clearInterval(typingTimer);
  if (currentTheme() !== "hud") {
    h1.textContent = `${identity.name} на связи. Чем помочь?`;
    if (sub) sub.textContent = "";
    return;
  }
  const text = `${timeGreeting()}, ${identity.address}.`;
  if (sub) sub.textContent = `${identity.name} на связи. Чем могу помочь?`;
  if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    h1.textContent = text;
    return;
  }
  let i = 0;
  h1.textContent = "";
  typingTimer = setInterval(() => {
    h1.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(typingTimer);
  }, 38);
}

/** Текст ожидания под ответом, пока модель не начала писать. */
export function waitingText(modelLoaded) {
  if (currentTheme() !== "hud") return modelLoaded ? "Думаю…" : "Загружаю модель в видеопамять…";
  return modelLoaded
    ? `Обрабатываю запрос, ${identity.address}…`
    : `Запускаю языковое ядро, ${identity.address}… (загрузка модели в видеопамять)`;
}

// ---------- часы в шапке ----------

const DAYS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];

function tickClock() {
  const el = $("hud-clock");
  if (!el) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  el.innerHTML = `<b>${pad(d.getHours())}:${pad(d.getMinutes())}<i>:${pad(d.getSeconds())}</i></b>` +
    `<span>${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}</span>`;
}

export function initHud() {
  mountCores();
  setCoreState("idle");
  tickClock();
  setInterval(tickClock, 1000);
}
