// =====================================================================
// Окно настроек, вкладка «Голос и данные»: голосовой ввод и экспорт.
// =====================================================================

import { api } from "./api.js";
import { refreshVoiceStatus } from "./voice.js";

const $ = (id) => document.getElementById(id);
let closeDialog = () => {};

export function initDataTab({ onClose }) {
  closeDialog = onClose;
  $("data-cancel").addEventListener("click", () => closeDialog());
  $("v-model").addEventListener("change", () => renderStatus());
  $("data-form").addEventListener("submit", save);
}

let voice = null;

export async function showDataTab() {
  const [{ values }, status] = await Promise.all([api.getSettings(), api.voiceStatus()]);
  voice = status;
  $("v-enabled").checked = values.voice_enabled;
  $("v-language").value = values.voice_language;
  const select = $("v-model");
  select.innerHTML = "";
  for (const [name, hint] of Object.entries(status.models)) select.append(new Option(`${name} — ${hint}`, name));
  select.value = values.whisper_model;
  $("data-error").hidden = true;
  renderStatus();
}

function renderStatus() {
  const el = $("v-status");
  if (!voice.installed) {
    el.textContent = "Распознавание речи не установлено. Перезапустите start.bat — он доустановит пакеты.";
    return;
  }
  const selected = $("v-model").value;
  el.textContent = selected === voice.model && voice.downloaded
    ? `Модель «${selected}» скачана — распознавание работает без интернета.`
    : `Модель «${selected}» ещё не скачана — скачается один раз при первой записи.`;
}

async function save(e) {
  e.preventDefault();
  try {
    await api.updateSettings({
      voice_enabled: $("v-enabled").checked,
      whisper_model: $("v-model").value,
      voice_language: $("v-language").value,
    });
  } catch (err) {
    $("data-error").textContent = err.message;
    $("data-error").hidden = false;
    return;
  }
  await refreshVoiceStatus(); // показать или спрятать кнопку микрофона
  closeDialog();
}
