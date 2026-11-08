// =====================================================================
// Тихие звуки интерфейса — синтезируются на лету (Web Audio API), без файлов.
// Браузер разрешает звук только после первого действия пользователя,
// поэтому AudioContext создаётся при первом клике или нажатии клавиши.
// =====================================================================

let ctx = null;
let enabled = true;
const VOLUME = 0.035; // очень тихо — звук должен «ощущаться», а не отвлекать

export function setSoundsEnabled(value) {
  enabled = value;
}

function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// Первое действие пользователя «разблокирует» звук
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => context()?.resume?.(), { once: true, capture: true });
}

/** Короткий тон: частота от from до to за duration секунд. */
function tone(from, to, duration, { type = "sine", delay = 0, volume = VOLUME } = {}) {
  const ac = context();
  if (!ac || ac.state !== "running") return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

const SOUNDS = {
  send: () => tone(900, 1400, 0.07),
  done: () => { tone(700, 700, 0.06); tone(1050, 1050, 0.09, { delay: 0.07 }); },
  error: () => tone(260, 180, 0.18, { type: "triangle", volume: VOLUME * 1.2 }),
  listen: () => tone(600, 1200, 0.12),
  stop: () => tone(1100, 500, 0.1),
  boot: () => { tone(220, 880, 0.45, { volume: VOLUME * 0.8 }); tone(1320, 1320, 0.12, { delay: 0.45 }); },
};

export function play(name) {
  if (enabled) SOUNDS[name]?.();
}
