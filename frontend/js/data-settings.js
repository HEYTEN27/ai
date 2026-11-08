// =====================================================================
// Окно настроек, вкладка «Голос и данные»: голосовой ввод и экспорт.
// =====================================================================

import { api } from "./api.js";
import { refreshVoiceStatus } from "./voice.js";
import { configureSpeech, localVoices, pickVoice, speak } from "./speech.js";
import { getIdentity } from "./hud.js";

const $ = (id) => document.getElementById(id);
let closeDialog = () => {};

export function initDataTab({ onClose }) {
  closeDialog = onClose;
  $("data-cancel").addEventListener("click", () => closeDialog());
  $("v-model").addEventListener("change", () => renderStatus());
  $("data-form").addEventListener("submit", save);
  $("tts-rate").addEventListener("input", () => ($("tts-rate-value").textContent = `${Number($("tts-rate").value).toFixed(2)}×`));
  $("tts-test").addEventListener("click", () => {
    // Пробуем с выбранными в форме (ещё не сохранёнными) голосом и скоростью
    configureSpeech({ tts_voice: $("tts-voice").value, tts_rate: Number($("tts-rate").value) });
    speak(`Все системы в норме, ${getIdentity().address}. Чем могу помочь?`, { force: true });
  });
}

/** Список русских офлайн-голосов системы (сетевые голоса Chrome не показываем: они отправляют текст в Google). */
function fillVoices(selected) {
  const select = $("tts-voice");
  const voices = localVoices();
  select.innerHTML = "";
  select.append(new Option("Автоматически (мужской, если есть)", ""));
  for (const v of voices) select.append(new Option(v.name, v.name));
  select.value = voices.some((v) => v.name === selected) ? selected : "";
  const note = $("tts-note");
  if (!voices.length) {
    note.textContent = "В системе нет русского офлайн-голоса. Windows: Параметры → Время и язык → Речь → " +
      "«Добавить голоса» → Русский (появится «Microsoft Pavel» и «Irina»), затем перезапустите браузер.";
    $("tts-test").disabled = true;
  } else {
    note.textContent = `Сейчас: «${pickVoice()?.name}»`;
    $("tts-test").disabled = false;
  }
}

let voice = null;

export async function showDataTab() {
  const [{ values }, status] = await Promise.all([api.getSettings(), api.voiceStatus()]);
  voice = status;
  $("v-enabled").checked = values.voice_enabled;
  $("t-tts").checked = values.tts_enabled;
  $("tts-rate").value = values.tts_rate;
  $("tts-rate-value").textContent = `${Number(values.tts_rate).toFixed(2)}×`;
  $("ui-sounds").checked = values.ui_sounds;
  fillVoices(values.tts_voice);
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
      tts_enabled: $("t-tts").checked,
      tts_voice: $("tts-voice").value,
      tts_rate: Number($("tts-rate").value),
      ui_sounds: $("ui-sounds").checked,
    });
  } catch (err) {
    $("data-error").textContent = err.message;
    $("data-error").hidden = false;
    return;
  }
  await refreshVoiceStatus(); // показать или спрятать кнопку микрофона
  window.dispatchEvent(new Event("voice-settings-changed")); // озвучка и звуки применятся сразу
  closeDialog();
}
