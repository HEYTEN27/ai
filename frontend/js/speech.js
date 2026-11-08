// =====================================================================
// Озвучивание ответов — встроенными голосами операционной системы.
//
// Важно про приватность: в браузере есть два вида голосов.
//   * «локальные» (voice.localService === true) — голоса Windows, например
//     «Microsoft Pavel» (мужской русский) и «Microsoft Irina». Работают офлайн.
//   * сетевые («Google русский» в Chrome) — текст уходит в Google.
// Мы используем ТОЛЬКО локальные. Если русского локального голоса нет —
// подсказываем, как добавить его в Windows.
//
// Код в ответах не зачитываем («код — на экране»), ссылки [1] и разметку убираем.
// =====================================================================

import { setCoreState } from "./hud.js";

const MALE_HINTS = /pavel|павел|dmitr|дмитр|maxim|максим|yuri|юрий|male|мужск/i;
let settings = { tts_enabled: true, tts_voice: "", tts_rate: 1.0 };
let speakingToken = 0;
let onStateChange = () => {};

export function speechSupported() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

/** Русские локальные (офлайн) голоса системы. */
export function localVoices() {
  if (!speechSupported()) return [];
  return speechSynthesis.getVoices().filter((v) => v.localService && v.lang.toLowerCase().startsWith("ru"));
}

export function pickVoice() {
  const voices = localVoices();
  if (!voices.length) return null;
  return voices.find((v) => v.name === settings.tts_voice)
    || voices.find((v) => MALE_HINTS.test(v.name)) // Джарвису идёт мужской голос
    || voices[0];
}

export function configureSpeech(newSettings, { onChange } = {}) {
  settings = { ...settings, ...newSettings };
  if (onChange) onStateChange = onChange;
}

export function ttsEnabled() {
  return Boolean(settings.tts_enabled && pickVoice());
}

/** Markdown-ответ → текст для чтения вслух. */
export function textForSpeech(markdown, limit = 1800) {
  let text = markdown
    .replace(/```[\s\S]*?```/g, " Код — на экране. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s?\[\d+\]/g, "") // ссылки на источники
    .replace(/https?:\/\/\S+/g, "ссылка")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > limit) {
    const cut = text.lastIndexOf(". ", limit);
    text = text.slice(0, cut > limit / 2 ? cut + 1 : limit) + " Остальное — на экране.";
  }
  return text;
}

/** Делим на предложения: длинные фразы Chrome иногда обрывает на середине. */
function sentences(text) {
  return (text.match(/[^.!?…]+[.!?…]*\s*/g) || [text]).reduce((parts, s) => {
    const last = parts[parts.length - 1];
    if (last && (last + s).length < 220) parts[parts.length - 1] = last + s;
    else parts.push(s);
    return parts;
  }, []).map((s) => s.trim()).filter(Boolean);
}

export function isSpeaking() {
  return speechSupported() && (speechSynthesis.speaking || speechSynthesis.pending);
}

export function stopSpeaking() {
  if (!speechSupported()) return;
  speakingToken++;
  speechSynthesis.cancel();
  setCoreState("idle");
  onStateChange(false);
}

/** Произносит текст. force — даже если автоозвучка выключена (кнопка 🔊 под ответом). */
export function speak(markdown, { force = false } = {}) {
  const voice = pickVoice();
  if (!voice || (!force && !settings.tts_enabled)) return false;
  stopSpeaking();
  const token = ++speakingToken;
  const parts = sentences(textForSpeech(markdown));
  if (!parts.length) return false;
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = settings.tts_rate || 1;
    u.pitch = 0.9; // чуть ниже — солиднее
    if (i === 0) u.onstart = () => token === speakingToken && (setCoreState("speaking"), onStateChange(true));
    if (i === parts.length - 1) {
      u.onend = u.onerror = () => {
        if (token !== speakingToken) return;
        setCoreState("idle");
        onStateChange(false);
      };
    }
    speechSynthesis.speak(u);
  });
  return true;
}

/** Голоса в браузере загружаются не сразу — ждём событие voiceschanged. */
export function onVoicesReady(callback) {
  if (!speechSupported()) return callback();
  if (speechSynthesis.getVoices().length) callback();
  speechSynthesis.addEventListener?.("voiceschanged", callback);
}
