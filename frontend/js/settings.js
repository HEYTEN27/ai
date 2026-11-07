// =====================================================================
// Окно настроек, вкладка «Основное»: имя, системный промпт, модель и
// персона по умолчанию, размер контекста с оценкой видеопамяти.
// =====================================================================

import { api } from "./api.js";
import { initPersonasTab, showPersonasTab } from "./personas-editor.js";

const $ = (id) => document.getElementById(id);
const dialog = $("settings-dialog");

let settingsData = null; // ответ GET /api/settings: { values, defaults, context_steps, kv_cache_types }
let onSavedCallback = () => {};
let estimateTimer = null;

/** Числа с пробелами-разделителями: 8 192. */
const fmt = (n) => n.toLocaleString("ru-RU");

/**
 * Подключает окно настроек.
 * @param {object} opts
 * @param {() => Map} opts.getModels — модели из выпадающего списка чата
 * @param {() => object[]} opts.getPersonas — список персон
 * @param {() => void} opts.onSaved — вызывается после сохранения (обновить интерфейс)
 */
export function initSettings({ getModels, getPersonas, onSaved }) {
  onSavedCallback = onSaved;

  $("settings-btn").addEventListener("click", () => openSettings({ getModels, getPersonas }));
  $("settings-close").addEventListener("click", () => dialog.close());
  $("general-cancel").addEventListener("click", () => dialog.close());
  // Клик по затемнённому фону вокруг окна тоже закрывает его
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  // Вкладки
  dialog.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  $("set-prompt-reset").addEventListener("click", () => {
    if (settingsData) $("set-prompt").value = settingsData.defaults.system_prompt;
  });

  // Любое изменение, влияющее на память, пересчитывает оценку
  for (const id of ["set-ctx", "set-kv", "set-model", "set-vram-total", "set-vram-reserved"]) {
    $(id).addEventListener("input", () => {
      updateContextLabel();
      scheduleEstimate();
    });
  }

  $("general-form").addEventListener("submit", saveGeneral);
  initPersonasTab({ getModels, onChanged: onSaved });
}

function switchTab(name) {
  dialog.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  dialog.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === "personas") showPersonasTab();
}

async function openSettings({ getModels, getPersonas }) {
  try {
    settingsData = await api.getSettings();
  } catch (e) {
    alert(`Не удалось загрузить настройки: ${e.message}`);
    return;
  }
  const v = settingsData.values;
  hideError();

  $("set-name").value = v.assistant_name;
  $("set-prompt").value = v.system_prompt;

  // Модель по умолчанию: скачанные модели + сохранённая, даже если её сейчас нет
  const modelSelect = $("set-model");
  modelSelect.innerHTML = "";
  const names = [...getModels().keys()];
  if (!names.includes(v.default_model)) names.unshift(v.default_model);
  for (const name of names) modelSelect.append(new Option(name, name));
  modelSelect.value = v.default_model;

  const personaSelect = $("set-persona");
  personaSelect.innerHTML = "";
  for (const p of getPersonas()) personaSelect.append(new Option(`${p.icon} ${p.name}`, p.id));
  personaSelect.value = v.default_persona_id ?? getPersonas()[0]?.id ?? "";

  // Ползунок контекста ходит по индексам массива context_steps (2K, 4K, 8K...)
  const steps = settingsData.context_steps;
  const ctxInput = $("set-ctx");
  ctxInput.max = steps.length - 1;
  let idx = steps.indexOf(v.num_ctx);
  if (idx === -1) idx = steps.findIndex((s) => s >= v.num_ctx); // значение не из списка — ближайшее
  ctxInput.value = idx === -1 ? steps.length - 1 : idx;

  $("set-kv").value = v.kv_cache_type;
  $("set-vram-total").value = v.vram_total_gb;
  $("set-vram-reserved").value = v.vram_reserved_gb;

  updateContextLabel();
  switchTab("general");
  dialog.showModal();
  refreshEstimate();
}

function currentContext() {
  return settingsData.context_steps[Number($("set-ctx").value)];
}

function updateContextLabel() {
  if (!settingsData) return;
  const ctx = currentContext();
  // Грубо: 1 токен ≈ 0,75 русского слова у Qwen3
  $("set-ctx-value").textContent = `${fmt(ctx)} токенов · примерно ${fmt(Math.round((ctx * 0.75) / 100) * 100)} слов`;
}

// Пересчитываем оценку не на каждое движение ползунка, а через 150 мс после остановки
function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(refreshEstimate, 150);
}

async function refreshEstimate() {
  const box = $("vram-estimate");
  const model = $("set-model").value;
  $("est-model").textContent = model || "—";
  box.classList.remove("is-ok", "is-warn", "is-danger", "is-unknown");

  const total = Number($("set-vram-total").value) || 8;
  const reserved = Number($("set-vram-reserved").value) || 0;
  let est;
  try {
    // Объём видеокарты в поле ещё не сохранён — поэтому считаем полоску по значениям из формы,
    // а сервер даёт размеры модели и KV-кэша.
    est = await api.vramEstimate({ model, num_ctx: currentContext(), kv_cache_type: $("set-kv").value });
  } catch (e) {
    box.classList.add("is-unknown");
    $("est-message").textContent = `Оценка недоступна: ${e.message}`;
    setBar(0, 0, 0, total);
    $("est-weights").textContent = $("est-kv").textContent = $("est-safe").textContent = "";
    return;
  }

  const kv = est.kv_gb ?? 0;
  const needed = est.weights_gb + kv;
  const available = total - reserved;
  const level = est.kv_gb === null ? "unknown" : needed > available ? "danger" : needed > available - 0.5 ? "warn" : "ok";
  box.classList.add(`is-${level}`);
  setBar(reserved, est.weights_gb, kv, total);
  $("est-weights").textContent = `${est.weights_gb.toFixed(1)} ГиБ`;
  $("est-kv").textContent = est.kv_gb === null ? "?" : `${kv.toFixed(2)} ГиБ`;

  const messages = {
    ok: `Поместится: ≈ ${needed.toFixed(1)} из ${available.toFixed(1)} ГиБ свободной видеопамяти.`,
    warn: `Впритык: ≈ ${needed.toFixed(1)} из ${available.toFixed(1)} ГиБ. Может не поместиться, если открыто много вкладок браузера или запущены игры.`,
    danger: `Скорее всего не поместится: нужно ≈ ${needed.toFixed(1)} ГиБ, свободно ≈ ${available.toFixed(1)} ГиБ. Часть модели уйдёт в оперативную память — ответы станут в несколько раз медленнее.`,
    unknown: est.message,
  };
  $("est-message").textContent = messages[level];
  // Безопасный максимум сервер считает по сохранённому объёму видеокарты
  $("est-safe").textContent = est.max_safe_context ? `безопасно до ${fmt(est.max_safe_context)} токенов` : "";
}

function setBar(reserved, weights, kv, total) {
  // Ширина сегментов в процентах от всей видеопамяти. Если всё вместе > 100% — полоска просто заполнена.
  const pct = (x) => `${Math.max(0, Math.min(100, (x / total) * 100))}%`;
  $("est-bar-reserved").style.width = pct(reserved);
  $("est-bar-weights").style.width = pct(weights);
  $("est-bar-kv").style.width = pct(kv);
}

async function saveGeneral(e) {
  e.preventDefault();
  hideError();
  const changes = {
    assistant_name: $("set-name").value.trim(),
    system_prompt: $("set-prompt").value,
    default_model: $("set-model").value,
    default_persona_id: $("set-persona").value ? Number($("set-persona").value) : null,
    num_ctx: currentContext(),
    kv_cache_type: $("set-kv").value,
    vram_total_gb: Number($("set-vram-total").value),
    vram_reserved_gb: Number($("set-vram-reserved").value),
  };
  if (!changes.assistant_name) {
    showError("Укажите имя ассистента");
    return;
  }
  try {
    await api.updateSettings(changes);
  } catch (err) {
    showError(err.message);
    return;
  }
  dialog.close();
  onSavedCallback();
}

function showError(text) {
  const el = $("general-error");
  el.textContent = text;
  el.hidden = false;
}

function hideError() {
  $("general-error").hidden = true;
}
