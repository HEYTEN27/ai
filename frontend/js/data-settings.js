// =====================================================================
// Окно настроек, вкладка «Голос и данные»: голосовой ввод, озвучивание
// ответов (нейроголос Piper или голос Windows) и экспорт.
// =====================================================================

import { api } from "./api.js";
import { refreshVoiceStatus } from "./voice.js";
import { configureSpeech, localVoices, pickVoice, setNeuralReady, speak } from "./speech.js";
import { getIdentity } from "./hud.js";

const $ = (id) => document.getElementById(id);
let closeDialog = () => {};
let tts = null; // ответ GET /api/voice/tts
let selectedNeural = "ruslan";
let pollTimer = null;

export function initDataTab({ onClose }) {
  closeDialog = onClose;
  $("data-cancel").addEventListener("click", () => {
    clearTimeout(pollTimer);
    window.dispatchEvent(new Event("voice-settings-changed")); // отменяем то, что пробовали кнопкой «Проверить голос»
    closeDialog();
  });
  $("v-model").addEventListener("change", () => renderStatus());
  $("data-form").addEventListener("submit", save);
  $("tts-rate").addEventListener("input", () => ($("tts-rate-value").textContent = `${Number($("tts-rate").value).toFixed(2)}×`));
  $("tts-engine").addEventListener("change", renderEngine);
  $("tts-test").addEventListener("click", testVoice);
}

// ---------- голоса ----------

/** Список русских офлайн-голосов Windows (сетевые голоса Chrome не показываем: они отправляют текст в Google). */
function fillSystemVoices(selected) {
  const select = $("tts-voice");
  const voices = localVoices();
  select.innerHTML = "";
  select.append(new Option("Автоматически (мужской, если есть)", ""));
  for (const v of voices) select.append(new Option(v.name, v.name));
  select.value = voices.some((v) => v.name === selected) ? selected : "";
}

function neuralUsable() {
  return Boolean(tts?.installed && tts.voices.find((v) => v.id === selectedNeural)?.downloaded);
}

function renderEngine() {
  const neural = $("tts-engine").value === "neural";
  $("tts-neural-box").hidden = !neural;
  $("tts-system-box").hidden = neural;
  const note = $("tts-note");
  const systemVoices = localVoices();
  if (neural && !tts?.installed) {
    note.textContent = "Нейроголос не установлен — перезапустите start.bat, он доустановит пакет piper-tts.";
  } else if (neural && !neuralUsable()) {
    note.textContent = "Скачайте выбранный голос — пока будет звучать голос Windows (если он есть).";
  } else if (!neural && !systemVoices.length) {
    note.textContent = "В Windows нет русского офлайн-голоса: Параметры → Время и язык → Речь → «Добавить голоса» → " +
      "Русский, затем перезапустите браузер. Или выберите нейроголос.";
  } else {
    note.textContent = neural ? `Сейчас: нейроголос «${selectedNeural}»` : `Сейчас: «${pickVoice()?.name}»`;
  }
  $("tts-test").disabled = neural ? !neuralUsable() : !systemVoices.length;
}

function renderNeuralVoices() {
  const box = $("tts-voices");
  box.innerHTML = "";
  $("tts-neural-note").textContent = tts.installed
    ? "Голос скачивается один раз (≈ 63 МБ) и дальше работает без интернета. Синтез — на процессоре, видеопамять не нужна."
    : "Пакет piper-tts не установлен — перезапустите start.bat.";
  const busy = tts.download && !tts.download.finished;
  for (const v of tts.voices) {
    const row = document.createElement("label");
    row.className = "tts-voice" + (v.id === selectedNeural ? " is-selected" : "");
    row.dataset.voice = v.id;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "tts-neural";
    radio.value = v.id;
    radio.checked = v.id === selectedNeural;
    radio.addEventListener("change", () => {
      selectedNeural = v.id;
      renderNeuralVoices();
      renderEngine();
    });
    const title = document.createElement("span");
    title.className = "tv-title";
    title.textContent = v.title + (v.recommended ? " · рекомендую" : "");
    const state = document.createElement("span");
    state.className = "tv-state";
    row.append(radio, title, state);
    if (v.downloaded) {
      state.textContent = "скачан ✓";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link-btn small danger";
      del.textContent = "удалить";
      del.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!confirm(`Удалить голос «${v.id}»? Его можно будет скачать снова.`)) return;
        await api.ttsDeleteVoice(v.id).catch((err) => alert(err.message));
        await loadTts();
      });
      row.append(del);
    } else {
      const get = document.createElement("button");
      get.type = "button";
      get.className = "btn btn-small tv-download";
      get.textContent = `Скачать · ${v.size_mb} МБ`;
      get.disabled = busy || !tts.installed;
      get.addEventListener("click", (e) => {
        e.preventDefault();
        startDownload(v.id);
      });
      row.append(get);
    }
    box.append(row);
  }
  renderProgress();
}

function renderProgress() {
  const d = tts.download;
  const box = $("tts-progress");
  box.hidden = !d || (d.finished && !d.error);
  if (!d) return;
  const pct = d.total ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0;
  $("tts-bar-fill").style.width = `${pct}%`;
  $("tts-progress-text").textContent = d.error ? d.error
    : d.finished ? "Готово" : `Скачиваю голос «${d.voice}»: ${pct}% (${(d.done / 1048576).toFixed(0)} из ${(d.total / 1048576).toFixed(0)} МБ)`;
  box.classList.toggle("is-error", Boolean(d.error));
}

async function startDownload(voice) {
  try {
    await api.ttsDownload(voice, $("tts-mirror").value);
  } catch (e) {
    alert(e.message);
    return;
  }
  selectedNeural = voice;
  await loadTts();
}

/** Пока идёт скачивание — опрашиваем сервер раз в 0,7 с и рисуем прогресс. */
async function loadTts() {
  clearTimeout(pollTimer);
  try {
    tts = await api.ttsStatus();
  } catch {
    tts = { installed: false, voices: [], download: null };
  }
  renderNeuralVoices();
  renderEngine();
  if (tts.download && !tts.download.finished && $("data-form").offsetParent !== null) {
    pollTimer = setTimeout(loadTts, 700);
  } else if (tts.download?.finished && !tts.download.error) {
    window.dispatchEvent(new Event("voice-settings-changed")); // голос появился — кнопка 🔊 в шапке оживает
  }
}

function testVoice() {
  const neural = $("tts-engine").value === "neural";
  // Пробуем с выбранными в форме (ещё не сохранёнными) настройками
  configureSpeech({
    tts_engine: neural ? "neural" : "system", tts_voice: $("tts-voice").value, tts_neural_voice: selectedNeural,
    tts_rate: Number($("tts-rate").value), tts_effect: $("tts-effect").checked,
  });
  if (neural) setNeuralReady(neuralUsable());
  if (neural && selectedNeural !== tts.voice) {
    // Сервер синтезирует сохранённым голосом — сначала сохраняем выбор
    api.updateSettings({ tts_neural_voice: selectedNeural }).then(() => (tts.voice = selectedNeural)).finally(say);
  } else {
    say();
  }
}

function say() {
  speak(`Все системы в норме, ${getIdentity().address}. Чем могу помочь?`, { force: true });
}

// ---------- открытие вкладки и сохранение ----------

let voice = null;

export async function showDataTab() {
  const [{ values }, status] = await Promise.all([api.getSettings(), api.voiceStatus()]);
  voice = status;
  $("v-enabled").checked = values.voice_enabled;
  $("t-tts").checked = values.tts_enabled;
  $("tts-engine").value = values.tts_engine;
  $("tts-effect").checked = values.tts_effect;
  $("tts-rate").value = values.tts_rate;
  $("tts-rate-value").textContent = `${Number(values.tts_rate).toFixed(2)}×`;
  $("ui-sounds").checked = values.ui_sounds;
  selectedNeural = values.tts_neural_voice;
  fillSystemVoices(values.tts_voice);
  await loadTts();
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
      tts_engine: $("tts-engine").value,
      tts_neural_voice: selectedNeural,
      tts_effect: $("tts-effect").checked,
      tts_voice: $("tts-voice").value,
      tts_rate: Number($("tts-rate").value),
      ui_sounds: $("ui-sounds").checked,
    });
  } catch (err) {
    $("data-error").textContent = err.message;
    $("data-error").hidden = false;
    return;
  }
  clearTimeout(pollTimer);
  await refreshVoiceStatus(); // показать или спрятать кнопку микрофона
  window.dispatchEvent(new Event("voice-settings-changed")); // озвучка и звуки применятся сразу
  closeDialog();
}
