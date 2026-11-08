// =====================================================================
// «▶ Проверить» под блоками кода (этап 11): самопроверка кода из ответа.
//   Python — в песочнице на сервере (та же, что у инструмента run_python: без сети и файлов).
//   JavaScript — в изолированном iframe в браузере (как артефакты: без доступа к приложению и сети).
// Если код упал — кнопка «🛠 Исправить» отправит Джарвису текст ошибки.
// =====================================================================

import { api } from "./api.js";

const PYTHON = new Set(["python", "py", "python3"]);
const JS = new Set(["javascript", "js", "mjs"]);
const JS_TIMEOUT = 5000;
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'";

let fixHandler = () => {};
export function setCodeFixHandler(fn) {
  fixHandler = fn;
}

function langOf(block) {
  return (block.querySelector(".code-header span")?.textContent || "").trim().toLowerCase();
}

/** Добавляет «▶ Проверить» в шапку блоков Python и JavaScript. */
export function addRunButtons(container) {
  container.querySelectorAll(".code-block").forEach((block) => {
    const lang = langOf(block);
    if ((!PYTHON.has(lang) && !JS.has(lang)) || block.querySelector(".run-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "run-btn";
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l11-7Z"/></svg><span>Проверить</span>';
    btn.title = PYTHON.has(lang) ? "Запустить в песочнице на этом компьютере (без сети и доступа к файлам)"
      : "Запустить в изолированной песочнице браузера";
    btn.addEventListener("click", () => run(block, lang, btn));
    block.querySelector(".code-header").insertBefore(btn, block.querySelector(".code-header button"));
  });
}

/** Автопроверка нового ответа (если включена в настройках): только Python, без input(), не огромный. */
export function autoCheck(messageEl) {
  messageEl.querySelectorAll(".code-block").forEach((block) => {
    const code = block.querySelector("pre code")?.innerText || "";
    if (PYTHON.has(langOf(block)) && !/\binput\s*\(/.test(code) && code.split("\n").length <= 200) {
      block.querySelector(".run-btn")?.click();
    }
  });
}

async function run(block, lang, btn) {
  const code = block.querySelector("pre code").innerText;
  block.nextElementSibling?.classList.contains("run-output") && block.nextElementSibling.remove();
  const out = document.createElement("div");
  out.className = "run-output is-running";
  out.textContent = "Запускаю…";
  block.after(out);
  btn.disabled = true;
  try {
    const result = PYTHON.has(lang) ? await runPython(code) : await runJs(code);
    renderResult(out, result, lang, code);
    out.scrollIntoView({ block: "nearest", behavior: "smooth" }); // результат может оказаться ниже края экрана
  } catch (e) {
    out.className = "run-output is-error";
    out.textContent = `Не удалось запустить: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function runPython(code) {
  const r = await api.runPython(code);
  const ok = r.exit_code === 0 && !r.timed_out;
  let error = r.stderr || "";
  if (r.timed_out) error += `\nКод не уложился в лимит времени (${r.duration} с) и был остановлен.`;
  if (/\binput\s*\(/.test(code) && /EOFError/.test(error)) {
    error += "\n(Код ждёт ввода с клавиатуры — в песочнице его нет. Это не ошибка самого кода.)";
  }
  return { ok, output: r.stdout || "", error: error.trim(), info: `Python · ${r.duration} с · код завершения ${r.exit_code}` };
}

/** JavaScript в песочнице: iframe без allow-same-origin + CSP без сети; console.log пересылается сюда. */
function runJs(code) {
  return new Promise((resolve) => {
    const token = Math.random().toString(36).slice(2);
    const lines = [];
    const errors = [];
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.className = "run-frame";
    const started = performance.now();
    const finish = (timedOut = false) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      frame.remove();
      if (timedOut) errors.push(`Код не завершился за ${JS_TIMEOUT / 1000} с и был остановлен.`);
      const seconds = ((performance.now() - started) / 1000).toFixed(2);
      resolve({ ok: !errors.length, output: lines.join("\n"), error: errors.join("\n"), info: `JavaScript · ${seconds} с` });
    };
    const onMessage = (e) => {
      const d = e.data;
      if (e.source !== frame.contentWindow || !d || d.t !== token) return;
      if (d.kind === "log") lines.push(d.text);
      else if (d.kind === "error") errors.push(d.text);
      else if (d.kind === "done") setTimeout(() => finish(), 150); // даём доработать таймерам (setTimeout 0..100 мс)
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => finish(true), JS_TIMEOUT);
    // Код вставляем как JSON-строку (с экранированным «<») и запускаем через Function —
    // так его не сломает закрывающий тег скрипта внутри кода
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>
      (function () {
        const T = ${JSON.stringify(token)};
        const send = (kind, text) => parent.postMessage({ t: T, kind, text }, "*");
        const fmt = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
        for (const level of ["log", "info", "warn", "debug", "table"]) console[level] = (...a) => send("log", a.map(fmt).join(" "));
        console.error = (...a) => send("error", a.map(fmt).join(" "));
        window.addEventListener("error", (e) => send("error", (e.message || "Ошибка") + (e.lineno ? " (строка " + e.lineno + ")" : "")));
        window.addEventListener("unhandledrejection", (e) => send("error", "Promise: " + (e.reason && e.reason.message || e.reason)));
        try {
          const result = new Function(${JSON.stringify(code).replace(/</g, "\\u003c")})();
          Promise.resolve(result).then(() => send("done"), (e) => { send("error", String(e)); send("done"); });
        } catch (e) { send("error", e.name + ": " + e.message); send("done"); }
      })();
    <\/script>`;
    document.body.append(frame);
  });
}

function renderResult(out, r, lang, code) {
  out.className = `run-output ${r.ok ? "is-ok" : "is-error"}`;
  out.innerHTML = "";
  const head = document.createElement("div");
  head.className = "run-head";
  head.textContent = (r.ok ? "✓ Код работает" : "⚠ При запуске ошибка") + ` · ${r.info}`;
  out.append(head);
  if (r.output) {
    const pre = document.createElement("pre");
    pre.textContent = r.output.length > 4000 ? r.output.slice(0, 4000) + "\n…" : r.output;
    out.append(pre);
  } else if (r.ok) {
    const empty = document.createElement("div");
    empty.className = "run-empty";
    empty.textContent = "Ничего не напечатал (нет print / console.log).";
    out.append(empty);
  }
  if (r.error) {
    const err = document.createElement("pre");
    err.className = "run-err";
    err.textContent = r.error.length > 3000 ? "…" + r.error.slice(-3000) : r.error;
    out.append(err);
  }
  if (!r.ok) {
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "btn fix-btn";
    fix.textContent = "🛠 Исправить";
    fix.title = "Отправить ошибку Джарвису";
    const name = PYTHON.has(lang) ? "python" : "javascript";
    const firstLine = code.split("\n").find((l) => l.trim()) || "";
    fix.addEventListener("click", () => fixHandler(
      `Код из твоего ответа (начинается с «${firstLine.trim().slice(0, 60)}») при запуске выдал ошибку:\n` +
      "```\n" + r.error.slice(-1500) + "\n```\nНайди причину, исправь и пришли полный исправленный код на " + name + "."));
    out.append(fix);
  }
}
