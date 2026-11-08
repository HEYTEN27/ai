// =====================================================================
// Озвучивание ответов (этапы «Джарвис» и 12).
//
// Два движка, оба офлайн:
//   * neural — нейроголос Piper на нашем сервере (звучит естественно). Браузер отправляет
//     предложение, получает WAV и играет его через Web Audio (там же — эффект «голос ИИ»);
//   * system — встроенные голоса Windows (speechSynthesis), только локальные: сетевые
//     голоса Chrome («Google русский») отправляют текст в Google, их не используем.
//
// Озвучка идёт ПО ПРЕДЛОЖЕНИЯМ ПРЯМО ВО ВРЕМЯ ОТВЕТА: как только модель дописала
// предложение, оно уходит на синтез, а следующее уже готовится, пока звучит текущее.
// Код не зачитываем («Код — на экране.»), ссылки [1] и разметку убираем.
// =====================================================================

import { setCoreState } from "./hud.js";

const MALE_HINTS = /pavel|павел|dmitr|дмитр|maxim|максим|yuri|юрий|male|мужск/i;
const MAX_SPOKEN = 2500; // дальше — «Остальное — на экране»
const PAUSE_MS = 140; // пауза между предложениями
const PREFETCH = 2; // сколько следующих предложений синтезировать заранее

let settings = { tts_enabled: true, tts_voice: "", tts_rate: 1.0, tts_engine: "neural", tts_effect: true };
let neuralReady = false;
let speakingToken = 0;
let session = null;
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

/** Готов ли нейроголос (пакет установлен, выбранный голос скачан) — сообщает app.js по /api/voice/tts. */
export function setNeuralReady(ready) {
  neuralReady = Boolean(ready);
}

/** Каким движком будем говорить: выбранным, а если он недоступен — тем, что есть. */
export function activeEngine() {
  if (settings.tts_engine === "neural" && neuralReady) return "neural";
  if (pickVoice()) return "system";
  if (neuralReady) return "neural";
  return null;
}

/** Описание голоса для подсказки на кнопке 🔊. */
export function voiceLabel() {
  const engine = activeEngine();
  if (engine === "neural") return `нейроголос «${settings.tts_neural_voice || "ruslan"}»`;
  if (engine === "system") return `голос «${pickVoice().name}»`;
  return "";
}

export function ttsEnabled() {
  return Boolean(settings.tts_enabled && activeEngine());
}

/** Markdown-ответ → текст для чтения вслух. */
export function textForSpeech(markdown, limit = 1800) {
  let text = markdown
    .replace(/```[\s\S]*?```/g, " Код — на экране. ")
    .replace(/```[\s\S]*$/g, " Код — на экране. ") // незакрытый блок (ответ оборвался)
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

/** Делим на предложения; короткие склеиваем, чтобы не было рваных пауз. */
export function sentences(text) {
  return (text.match(/[^.!?…]+[.!?…]*\s*/g) || [text]).reduce((parts, s) => {
    const last = parts[parts.length - 1];
    if (last && (last + s).length < 220 && last.length < 40) parts[parts.length - 1] = last + s;
    else parts.push(s);
    return parts;
  }, []).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * До какого места потокового markdown можно уже читать: конец последнего законченного
 * предложения, не внутри блока кода. Незакрытый блок кода (модель его ещё пишет) — стоп.
 */
export function speakableUntil(raw, from = 0) {
  const fences = [...raw.matchAll(/^[ \t]*```/gm)].map((m) => m.index);
  const spans = [];
  for (let i = 0; i + 1 < fences.length; i += 2) spans.push([fences[i], fences[i + 1] + 3]);
  const limit = fences.length % 2 ? fences[fences.length - 1] : raw.length;
  const inCode = (pos) => spans.some(([a, b]) => pos >= a && pos < b);
  let end = from;
  const re = /[.!?…]+(?=\s)|\n\s*\n/g;
  re.lastIndex = from;
  for (let m = re.exec(raw); m && m.index < limit; m = re.exec(raw)) {
    if (!inCode(m.index)) end = m.index + m[0].length;
  }
  // Закрытый блок кода попадает в кусок целиком и превращается в «Код — на экране»
  return end;
}

// ---------- Web Audio: проигрывание нейроголоса и эффект ----------

let audioCtx = null;
let impulse = null;

function context() {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Браузер разрешает звук только после действия пользователя — «будим» его на первом клике/клавише
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => { if (audioCtx?.state === "suspended") audioCtx.resume(); }, { capture: true });
}

/** Импульс «небольшого помещения» — короткое затухающее эхо, без файлов (генерируем шум). */
function roomImpulse(ctx) {
  if (impulse) return impulse;
  const length = Math.floor(ctx.sampleRate * 0.45);
  impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
  }
  return impulse;
}

/**
 * Цепочка «голос ИИ»: тембр на полтона ниже (playbackRate), убираем гул, чуть больше «присутствия»
 * на 3 кГц и немного пространства. Эффект лёгкий — разборчивость важнее.
 */
function connectChain(ctx, source) {
  if (!settings.tts_effect) {
    source.connect(ctx.destination);
    return;
  }
  source.playbackRate.value = 0.965;
  const highpass = new BiquadFilterNode(ctx, { type: "highpass", frequency: 95 });
  const presence = new BiquadFilterNode(ctx, { type: "peaking", frequency: 3000, Q: 0.9, gain: 2.5 });
  const dry = new GainNode(ctx, { gain: 0.92 });
  const wet = new GainNode(ctx, { gain: 0.16 });
  const reverb = new ConvolverNode(ctx, { buffer: roomImpulse(ctx) });
  const comp = new DynamicsCompressorNode(ctx, { threshold: -18, ratio: 3 });
  source.connect(highpass).connect(presence);
  presence.connect(dry).connect(comp);
  presence.connect(reverb).connect(wet).connect(comp);
  comp.connect(ctx.destination);
}

async function synthesize(text) {
  const r = await fetch("/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rate: settings.tts_rate || 1 }),
  });
  if (!r.ok) throw new Error(`синтез: ${r.status}`);
  const data = await r.arrayBuffer();
  return context().decodeAudioData(data);
}

function playBuffer(buffer, s) {
  return new Promise((resolve) => {
    const ctx = context();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    connectChain(ctx, source);
    s.source = source;
    source.onended = () => setTimeout(resolve, PAUSE_MS);
    source.start();
  });
}

// ---------- сессия озвучки: очередь предложений ----------

function newSession(engine) {
  stopSpeaking();
  session = { token: ++speakingToken, engine, queue: [], closed: false, started: false, spoken: 0,
    wake: null, running: false, pendingSystem: 0, source: null };
  return session;
}

function markStarted(s) {
  if (s.started || s.token !== speakingToken) return;
  s.started = true;
  setCoreState("speaking");
  onStateChange(true);
}

function markDone(s) {
  if (s.token !== speakingToken) return;
  session = null;
  setCoreState("idle");
  onStateChange(false);
}

/** Текст (уже без разметки) → предложения в очередь. */
function enqueueText(s, plain) {
  for (const sentence of sentences(plain)) {
    if (s.spoken >= MAX_SPOKEN) {
      if (!s.truncated) {
        s.truncated = true;
        enqueueSentence(s, "Остальное — на экране.");
      }
      return;
    }
    s.spoken += sentence.length;
    enqueueSentence(s, sentence);
  }
}

function enqueueSentence(s, text) {
  if (s.engine === "system") {
    const voice = pickVoice();
    if (!voice) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = settings.tts_rate || 1;
    u.pitch = 0.9; // чуть ниже — солиднее
    s.pendingSystem++;
    u.onstart = () => markStarted(s);
    u.onend = u.onerror = () => {
      s.pendingSystem--;
      if (s.closed && s.pendingSystem <= 0) markDone(s);
    };
    speechSynthesis.speak(u); // у системного голоса своя очередь — просто добавляем
    return;
  }
  const item = { text, audio: null };
  item.load = () => (item.audio ??= synthesize(text).catch(() => null)); // ошибка синтеза — пропускаем фразу
  s.queue.push(item);
  // Предзагрузка: пока звучит одно предложение, следующие уже синтезируются
  s.queue.slice(0, PREFETCH).forEach((i) => i.load());
  s.wake?.();
  pump(s);
}

async function pump(s) {
  if (s.running) return;
  s.running = true;
  while (s.token === speakingToken) {
    const item = s.queue.shift();
    if (!item) {
      if (s.closed) break;
      await new Promise((resolve) => (s.wake = resolve)); // ждём следующее предложение из стрима
      s.wake = null;
      continue;
    }
    s.queue.slice(0, PREFETCH).forEach((i) => i.load());
    const buffer = await item.load();
    if (s.token !== speakingToken) break;
    if (!buffer) continue;
    markStarted(s);
    await playBuffer(buffer, s);
  }
  s.running = false;
  if (s.closed) markDone(s);
}

function closeSession(s) {
  s.closed = true;
  s.wake?.();
  if (s.engine === "system" && s.pendingSystem <= 0) markDone(s);
}

export function isSpeaking() {
  return Boolean(session) || (speechSupported() && (speechSynthesis.speaking || speechSynthesis.pending));
}

export function stopSpeaking() {
  speakingToken++;
  if (session) {
    try {
      session.source?.stop();
    } catch {
      /* уже остановлен */
    }
    session.wake?.();
    session = null;
  }
  if (speechSupported()) speechSynthesis.cancel();
  setCoreState("idle");
  onStateChange(false);
}

/** Произносит готовый текст целиком. force — даже если автоозвучка выключена (кнопка 🔊 под ответом). */
export function speak(markdown, { force = false } = {}) {
  const engine = activeEngine();
  if (!engine || (!force && !settings.tts_enabled)) return false;
  const s = newSession(engine);
  enqueueText(s, textForSpeech(markdown, MAX_SPOKEN));
  closeSession(s);
  return true;
}

/**
 * Озвучка потокового ответа: feed(текст_целиком_на_сейчас) на каждый токен, finish(...) в конце.
 * Если озвучка выключена или голоса нет — все методы ничего не делают.
 */
export function createStreamSpeaker() {
  const engine = settings.tts_enabled ? activeEngine() : null;
  if (!engine) return { feed() {}, finish() {}, cancel() {} };
  const s = newSession(engine);
  let pos = 0;
  const push = (chunk) => {
    const plain = textForSpeech(chunk, Infinity);
    if (plain) enqueueText(s, plain);
  };
  return {
    feed(raw) {
      if (s.token !== speakingToken) return;
      const end = speakableUntil(raw, pos);
      if (end > pos) {
        push(raw.slice(pos, end));
        pos = end;
      }
    },
    finish(raw) {
      if (s.token !== speakingToken) return;
      if (raw.length > pos) push(raw.slice(pos));
      pos = raw.length;
      closeSession(s);
    },
    cancel() {
      if (s.token === speakingToken) stopSpeaking();
    },
  };
}

/** Голоса в браузере загружаются не сразу — ждём событие voiceschanged. */
export function onVoicesReady(callback) {
  if (!speechSupported()) return callback();
  if (speechSynthesis.getVoices().length) callback();
  speechSynthesis.addEventListener?.("voiceschanged", callback);
}
