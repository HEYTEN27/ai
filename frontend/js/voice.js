// =====================================================================
// Голосовой ввод: запись с микрофона в браузере → распознавание на сервере
// (Whisper на этом компьютере) → текст вставляется в поле ввода.
//
// Запись делает MediaRecorder — встроенный в браузер «диктофон». Доступ к
// микрофону браузер даёт только «безопасным» страницам; http://127.0.0.1 к ним
// относится, поэтому всё работает без HTTPS.
// =====================================================================

import { api } from "./api.js";
import { setCoreState } from "./hud.js";
import { play } from "./sounds.js";
import { stopSpeaking } from "./speech.js";

const $ = (id) => document.getElementById(id);
const MAX_SECONDS = 120; // больше двух минут за раз не записываем

let status = null; // ответ /api/voice/status
let recorder = null;
let chunks = [];
let cancelled = false;
let timer = null;
let startedAt = 0;
let onTextCallback = () => {};

export function initVoice({ onText }) {
  onTextCallback = onText;
  $("mic-btn").addEventListener("click", () => (recorder ? stopRecording() : startRecording()));
  // Esc во время записи — отменить без распознавания
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && recorder) {
      cancelled = true;
      stopRecording();
    }
  });
  refreshVoiceStatus();
}

export async function refreshVoiceStatus() {
  try {
    status = await api.voiceStatus();
  } catch {
    status = null;
  }
  // Кнопку показываем, только если Whisper установлен, голос включён и браузер умеет записывать
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  $("mic-btn").hidden = !(status?.installed && status.enabled && supported);
  return status;
}

async function startRecording() {
  if (!status.downloaded && !status.loaded) {
    const ok = confirm(
      `Голосовой ввод работает на этом компьютере. При первой записи скачается модель распознавания речи ` +
      `«${status.model}» (${status.models[status.model]}) — это один раз, потом всё работает без интернета. Продолжить?`,
    );
    if (!ok) return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert(e.name === "NotFoundError"
      ? "Микрофон не найден. Подключите его и попробуйте снова."
      : "Нет доступа к микрофону. Разрешите его в браузере: значок слева от адреса → Микрофон → Разрешить.");
    return;
  }
  // opus в webm — компактно и понятно серверу (PyAV); если браузер не умеет — берём его формат по умолчанию
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  cancelled = false;
  recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
  recorder.addEventListener("stop", () => {
    stream.getTracks().forEach((t) => t.stop()); // выключаем микрофон (гаснет значок записи)
    finishRecording();
  });
  stopSpeaking(); // чтобы микрофон не записал голос самого ассистента
  recorder.start();
  setCoreState("listening");
  play("listen");
  startedAt = Date.now();
  $("mic-btn").classList.add("recording");
  $("mic-btn").title = "Остановить запись (Esc — отменить)";
  $("mic-timer").hidden = false;
  tick();
  timer = setInterval(tick, 250);
}

function tick() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  $("mic-timer").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  if (seconds >= MAX_SECONDS) stopRecording();
}

function stopRecording() {
  clearInterval(timer);
  setCoreState("idle");
  $("mic-timer").hidden = true;
  $("mic-btn").classList.remove("recording");
  $("mic-btn").title = "Голосовой ввод (распознаётся на этом компьютере)";
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function finishRecording() {
  const type = recorder?.mimeType || "audio/webm";
  recorder = null;
  if (cancelled || !chunks.length) return;
  const blob = new Blob(chunks, { type });
  const btn = $("mic-btn");
  btn.classList.add("busy");
  btn.title = status.loaded ? "Распознаю…" : "Загружаю модель распознавания (первый раз — дольше)…";
  try {
    const result = await api.transcribe(blob);
    if (result.text) onTextCallback(result.text);
    else alert("Не удалось разобрать речь — попробуйте говорить ближе к микрофону.");
    status.loaded = true;
    status.downloaded = true;
  } catch (e) {
    alert(e.message);
  } finally {
    btn.classList.remove("busy");
    btn.title = "Голосовой ввод (распознаётся на этом компьютере)";
  }
}
