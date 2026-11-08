// =====================================================================
// Загрузочная заставка: ядро «раскручивается», строки состояния систем
// печатаются по одной, затем — приветствие. ~2,5 секунды.
//
// Показывается один раз за сеанс браузера, только в теме HUD. Пропускается
// кликом или любой клавишей. Не показывается, если пользователь просил меньше
// анимаций, и в автотестах (navigator.webdriver). ?boot в адресе — показать принудительно.
// =====================================================================

import { api } from "./api.js";
import { coreSVG, currentTheme, getIdentity, timeGreeting } from "./hud.js";
import { play } from "./sounds.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shouldShow() {
  const forced = new URLSearchParams(location.search).has("boot");
  if (forced) return true;
  if (currentTheme() !== "hud" || navigator.webdriver) return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    return !sessionStorage.getItem("booted");
  } catch {
    return false;
  }
}

/** Что сообщить о системах — собираем параллельно, не дольше 1,2 секунды. */
async function systemsReport() {
  const timeout = new Promise((r) => setTimeout(() => r(null), 1200));
  const safe = (p) => Promise.race([p.catch(() => null), timeout]);
  const [health, models, memory, knowledge] = await Promise.all([
    safe(api.health()), safe(api.models()), safe(api.listMemory()), safe(api.knowledge()),
  ]);
  const lines = [];
  lines.push({ text: "Инициализация систем", status: "ok" });
  if (health?.ok) {
    lines.push({ text: `Языковое ядро · ${models?.default_model || "—"} · Ollama ${health.version}`, status: "ok" });
  } else {
    lines.push({ text: "Языковое ядро недоступно — запустите Ollama", status: "warn" });
  }
  if (memory) lines.push({ text: `Долговременная память · фактов: ${memory.stats.count}`, status: "ok" });
  if (knowledge) lines.push({ text: `База знаний · документов: ${knowledge.stats.ready}`, status: "ok" });
  lines.push({ text: "Протоколы безопасности · данные остаются на этом компьютере", status: "ok" });
  return lines;
}

export async function runBoot() {
  if (!shouldShow()) return;
  try {
    sessionStorage.setItem("booted", "1");
  } catch {
    /* ignore */
  }
  const overlay = document.createElement("div");
  overlay.className = "boot";
  overlay.setAttribute("role", "status");
  overlay.innerHTML = `
    <div class="boot-core">${coreSVG("boot")}</div>
    <div class="boot-title"></div>
    <div class="boot-sub">PERSONAL AI SYSTEM · LOCAL MODE</div>
    <ul class="boot-lines"></ul>
    <div class="boot-greeting"></div>
    <div class="boot-skip">нажмите любую клавишу, чтобы пропустить</div>`;
  overlay.querySelector(".boot-title").textContent = getIdentity().name.toUpperCase();
  document.body.append(overlay);
  document.body.dataset.core = "thinking";
  play("boot");

  let skipped = false;
  const skip = () => { skipped = true; };
  overlay.addEventListener("click", skip);
  window.addEventListener("keydown", skip, { once: true });

  const report = systemsReport();
  await sleep(500);
  const list = overlay.querySelector(".boot-lines");
  for (const line of await report) {
    if (skipped) break;
    const li = document.createElement("li");
    li.className = line.status;
    li.innerHTML = `<span class="t"></span><span class="s">${line.status === "ok" ? "OK" : "!"}</span>`;
    li.querySelector(".t").textContent = line.text;
    list.append(li);
    await sleep(260);
  }
  if (!skipped) {
    const { address } = getIdentity();
    overlay.querySelector(".boot-greeting").textContent = `${timeGreeting()}, ${address}.`;
    overlay.classList.add("greet");
    await sleep(900);
  }
  overlay.classList.add("leaving");
  document.body.dataset.core = "idle";
  await sleep(450);
  overlay.remove();
  window.removeEventListener("keydown", skip);
}
