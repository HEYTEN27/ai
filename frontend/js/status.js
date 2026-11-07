// =====================================================================
// Модели и состояние: выпадающий список моделей, переключатель
// «Размышлять», индикатор видеопамяти, связь с Ollama.
// =====================================================================

import { api } from "./api.js";

const GB = 1024 ** 3;

/** Подпись модели в списке: «qwen3:8b — 8.2B, Q4_K_M». */
function modelLabel(m) {
  const details = [m.parameter_size, m.quantization].filter(Boolean).join(", ");
  let label = details ? `${m.name} — ${details}` : m.name;
  if (m.is_large) label += " (медленно, частично на CPU)";
  return label;
}

/**
 * Заполняет выпадающий список моделей.
 * @returns {Map<string, object>} модели по имени
 */
export function fillModelSelect(select, models, selected) {
  select.innerHTML = "";
  const byName = new Map();
  if (!models.length) {
    const opt = new Option("Нет скачанных моделей", "");
    opt.disabled = true;
    select.append(opt);
    return byName;
  }
  // Сначала модели, которые помещаются в VRAM, потом большие
  const sorted = [...models].sort((a, b) => Number(a.is_large) - Number(b.is_large));
  for (const m of sorted) {
    byName.set(m.name, m);
    select.append(new Option(modelLabel(m), m.name));
  }
  select.value = byName.has(selected) ? selected : sorted[0].name;
  return byName;
}

/** Обновляет точку «Ollama подключена / недоступна» внизу боковой панели. */
export function renderConnection(health) {
  const el = document.getElementById("conn-status");
  el.classList.remove("is-ok", "is-error");
  const text = el.querySelector(".conn-text");
  if (health.ok) {
    el.classList.add("is-ok");
    const name = health.backend === "ollama" ? "Ollama" : "llama.cpp";
    text.textContent = health.version ? `${name} ${health.version}` : `${name} подключена`;
  } else {
    el.classList.add("is-error");
    text.textContent = "Ollama недоступна";
  }
}

/**
 * Индикатор VRAM в верхней панели + плашка-предупреждение.
 * Показывает состояние выбранной модели: целиком в видеопамяти, частично или не загружена.
 */
export function renderVram(status, selectedModel) {
  const el = document.getElementById("vram-indicator");
  const text = el.querySelector(".vram-text");
  el.classList.remove("is-ok", "is-warn", "is-error");

  if (!status.ok) {
    el.classList.add("is-error");
    text.textContent = "нет связи";
    el.title = status.error || "";
    return;
  }
  if (!status.supported) {
    text.textContent = "VRAM: нет данных";
    el.title = "Этот движок не сообщает, сколько модели в видеопамяти";
    return;
  }

  const loaded = status.loaded.find((m) => m.name === selectedModel);
  if (!loaded) {
    text.textContent = "не загружена";
    el.title = "Модель загрузится в видеопамять при первом сообщении (10–30 секунд)";
    return;
  }
  const sizeGb = (loaded.size_bytes / GB).toFixed(1);
  if (loaded.fully_on_gpu) {
    el.classList.add("is-ok");
    text.textContent = `GPU 100% · ${sizeGb} ГБ`;
    el.title = `Модель целиком в видеопамяти. Контекст: ${loaded.context_length ?? "?"} токенов`;
  } else {
    el.classList.add("is-warn");
    text.textContent = `GPU ${Math.round(loaded.gpu_percent)}% · ${sizeGb} ГБ`;
    el.title = "Часть модели в оперативной памяти — генерация медленнее";
  }
}

/** Текст предупреждения, если выбранная модель не поместилась в видеопамять целиком. */
export function vramWarning(status, selectedModel) {
  const m = status.loaded?.find((x) => x.name === selectedModel);
  if (!m || m.fully_on_gpu || m.is_embedding) return null;
  return (
    `Модель ${m.name} помещается в видеопамять только на ${Math.round(m.gpu_percent)}% — ` +
    "остальное в оперативной памяти, ответы будут заметно медленнее. " +
    "Уменьшите контекст, закройте программы, которые используют видеокарту " +
    "(браузер, Wallpaper Engine), или выберите модель поменьше."
  );
}

/** Плашка над чатом: предупреждение о VRAM или о недоступной Ollama. */
export function renderBanner({ text = null, html = null, error = false } = {}) {
  const banner = document.getElementById("banner");
  if (!text && !html) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.classList.toggle("is-error", error);
  if (html) banner.innerHTML = html;
  else banner.textContent = text;
}

/** Периодически опрашивает сервер о состоянии VRAM (только когда вкладка открыта). */
export function startStatusPolling(onStatus, intervalMs = 5000) {
  async function tick() {
    if (document.hidden) return;
    try {
      onStatus(await api.status());
    } catch {
      /* сервер недоступен — следующий тик попробует снова */
    }
  }
  tick();
  return setInterval(tick, intervalMs);
}
