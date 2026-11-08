// =====================================================================
// Отрисовка сообщений в окне чата.
// =====================================================================

import { copyText, enhanceCodeBlocks, renderMarkdown } from "./markdown.js";
import { openSource } from "./knowledge.js";
import { describeEvent, plural } from "./memory.js";

const messagesEl = () => document.getElementById("messages");

// Функция «id персоны → персона». Задаётся из app.js, где хранится список персон.
let personaLookup = () => null;
export function setPersonaLookup(fn) {
  personaLookup = fn;
}

// «id факта → текст факта» — для подсказки «какие факты из памяти учтены в ответе»
let memoryLookup = () => null;
export function setMemoryLookup(fn) {
  memoryLookup = fn;
}

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
};

/** Прокручен ли чат почти до конца? Если пользователь листает вверх — не дёргаем его. */
function isNearBottom() {
  const el = messagesEl();
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

export function scrollToBottom(force = false) {
  const el = messagesEl();
  if (force || isNearBottom()) el.scrollTop = el.scrollHeight;
}

/** Очищает окно и показывает пустой экран с подсказками. */
export function clearMessages() {
  const el = messagesEl();
  el.querySelectorAll(".msg").forEach((m) => m.remove());
  document.getElementById("empty-state").hidden = false;
}

function hideEmptyState() {
  document.getElementById("empty-state").hidden = true;
}

export function addUserMessage(text) {
  hideEmptyState();
  const msg = document.createElement("div");
  msg.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text; // textContent, а не innerHTML — текст пользователя не исполняется как HTML
  msg.append(bubble);
  messagesEl().append(msg);
  scrollToBottom(true);
  return msg;
}

/** Текст под ответом: «💻 Программист · qwen3:8b · 42 ток/с · 128 ток.». */
function metaText(message) {
  const parts = [];
  const persona = message.persona_id ? personaLookup(message.persona_id) : null;
  if (persona) parts.push(`${persona.icon} ${persona.name}`);
  if (message.model) parts.push(message.model);
  const s = message.stats;
  if (s?.tokens_per_second) parts.push(`${s.tokens_per_second} ток/с`);
  if (s?.completion_tokens) parts.push(`${s.completion_tokens} ток.`);
  return parts.join(" · ");
}

/**
 * Создаёт «пузырь» ответа ассистента и возвращает объект для его наполнения.
 * Используется и для готовых сообщений из истории, и для потокового ответа.
 */
export function createAssistantMessage({ onRetry } = {}) {
  hideEmptyState();
  const msg = document.createElement("div");
  msg.className = "msg msg-assistant";
  msg.innerHTML = `
    <details class="thinking" hidden><summary>Размышления</summary><div class="thinking-body"></div></details>
    <div class="tool-cards"></div>
    <div class="content"></div>
    <div class="msg-meta" hidden>
      <span class="meta-text"></span>
      <button class="icon-btn btn-copy" type="button" title="Копировать ответ">${ICONS.copy}</button>
      <button class="icon-btn btn-retry" type="button" title="Ответить заново" hidden>${ICONS.retry}</button>
    </div>`;
  messagesEl().append(msg);

  const thinkingEl = msg.querySelector(".thinking");
  const thinkingBody = msg.querySelector(".thinking-body");
  const contentEl = msg.querySelector(".content");
  const toolsEl = msg.querySelector(".tool-cards");
  const toolCards = new Map(); // id вызова → карточка
  const metaEl = msg.querySelector(".msg-meta");
  const retryBtn = msg.querySelector(".btn-retry");

  let content = "";
  let thinking = "";
  let renderScheduled = false;

  // Перерисовываем markdown не на каждый токен, а не чаще одного раза за кадр экрана
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      const stick = isNearBottom();
      contentEl.innerHTML = renderMarkdown(content);
      enhanceCodeBlocks(contentEl, { highlight: false });
      thinkingBody.textContent = thinking;
      if (stick) scrollToBottom(true);
    });
  }

  msg.querySelector(".btn-copy").addEventListener("click", (e) => {
    copyText(content);
    e.currentTarget.title = "Скопировано";
  });
  retryBtn.addEventListener("click", () => onRetry?.());

  return {
    element: msg,

    /** Показать «ожидание» до первого токена (модель может загружаться в VRAM). */
    setWaiting(text = "Думаю…") {
      msg.classList.add("streaming-wait");
      contentEl.innerHTML = `<div class="waiting">${text}</div>`;
    },

    startStreaming() {
      msg.classList.add("streaming");
    },

    appendThinking(text) {
      if (!thinking) {
        thinkingEl.hidden = false;
        thinkingEl.open = true; // пока модель думает — показываем ход мыслей
        contentEl.innerHTML = "";
      }
      thinking += text;
      scheduleRender();
    },

    appendContent(text) {
      if (!content && thinking) thinkingEl.open = false; // начался ответ — сворачиваем мысли
      content += text;
      scheduleRender();
    },

    /**
     * Генерация закончена (успешно, остановлена или с ошибкой).
     * memoryFacts — факты из памяти, которые были в контексте (из события start).
     * sources — фрагменты базы знаний, на которые модель может ссылаться [1], [2].
     */
    finish({ message, stopped = false, error = null, memoryFacts = null, sources = null } = {}) {
      msg.classList.remove("streaming", "streaming-wait");
      for (const card of toolCards.values()) card.cancel(); // незавершённые инструменты — «остановлено»
      if (message) {
        content = message.content ?? content;
        thinking = message.thinking ?? thinking;
      }
      contentEl.innerHTML = renderMarkdown(content);
      enhanceCodeBlocks(contentEl, { highlight: true });
      const srcList = sources ?? message?.extras?.sources ?? [];
      if (srcList.length) {
        linkifyCitations(contentEl, srcList);
        renderSources(msg, metaEl, srcList);
      }
      if (thinking) {
        thinkingEl.hidden = false;
        thinkingEl.open = false;
        thinkingBody.textContent = thinking;
      }

      const meta = metaText(message || {});
      const metaSpan = metaEl.querySelector(".meta-text");
      metaSpan.textContent = meta;
      if (stopped || message?.stopped) {
        const tag = document.createElement("span");
        tag.className = "tag-stopped";
        tag.textContent = meta ? " · остановлено" : "остановлено";
        metaSpan.append(tag);
      }
      // «🧠 3 факта» — сколько фактов из памяти было в контексте; при наведении — какие
      const facts = memoryFacts
        ?? (message?.extras?.memory_ids || []).map((id) => ({ id, content: memoryLookup(id) ?? "(факт уже удалён)" }));
      if (facts.length) {
        const mem = document.createElement("span");
        mem.className = "meta-memory";
        mem.textContent = `🧠 ${plural(facts.length, "факт", "факта", "фактов")}`;
        mem.title = "Учтено из памяти:\n" + facts.map((f) => `• ${f.content}`).join("\n");
        metaSpan.append(meta ? " · " : "", mem);
      }
      metaEl.hidden = !(content || meta);

      if (error) {
        const errEl = document.createElement("div");
        errEl.className = "msg-error";
        errEl.textContent = error;
        msg.append(errEl);
      }
      scrollToBottom();
    },

    setRetryVisible(visible) {
      retryBtn.hidden = !visible;
    },

    /** Под ответом: «💾 Запомнил: «…» · Отменить». onUndo(event) возвращает обновлённое событие. */
    /** Модель вызвала инструмент — показываем карточку «выполняю…». */
    toolStart(entry) {
      if (msg.classList.contains("streaming-wait")) contentEl.innerHTML = ""; // убираем «Думаю…»
      const card = createToolCard(entry);
      toolCards.set(entry.id, card);
      toolsEl.append(card.element);
      scrollToBottom();
    },

    /** Нужно подтверждение: в карточке появляются кнопки. onAnswer(approved) отправляет ответ. */
    toolConfirm(entry, onAnswer) {
      toolCards.get(entry.id)?.askConfirm(entry, onAnswer);
      scrollToBottom(true);
    },

    toolResult(entry) {
      let card = toolCards.get(entry.id);
      if (!card) {
        card = createToolCard(entry);
        toolCards.set(entry.id, card);
        toolsEl.append(card.element);
      }
      card.setResult(entry);
    },

    showMemoryEvents(events, onUndo) {
      if (!events?.length) return;
      let box = msg.querySelector(".memory-notes");
      if (!box) {
        box = document.createElement("div");
        box.className = "memory-notes";
        msg.append(box);
      }
      for (const ev of events) box.append(memoryNote(ev, onUndo));
    },
  };
}

/**
 * Превращает «[1]» в тексте ответа в кнопки, открывающие источник.
 * Меняем только текстовые узлы и не трогаем код: в коде [1] — это индекс массива.
 * Номера, которых нет среди источников (модель выдумала), остаются обычным текстом.
 */
function linkifyCitations(container, sources) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement.closest("code, pre, .cite") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) if (/\[\d+\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const m of node.nodeValue.matchAll(/\[(\d+)\]/g)) {
      const source = byNumber.get(Number(m[1]));
      if (!source) continue;
      fragment.append(node.nodeValue.slice(last, m.index));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cite";
      btn.textContent = m[1];
      btn.title = source.label;
      btn.addEventListener("click", () => openSource(source));
      fragment.append(btn);
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    fragment.append(node.nodeValue.slice(last));
    node.replaceWith(fragment);
  }
}

/** Под ответом: «Источники: [1] Лекция 3, стр. 5 · [2] Замыкания.md › Примеры». */
function renderSources(msg, metaEl, sources) {
  msg.querySelector(".sources")?.remove();
  const box = document.createElement("div");
  box.className = "sources";
  const label = document.createElement("span");
  label.className = "sources-label";
  label.textContent = "Источники:";
  box.append(label);
  for (const s of sources) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "source-chip";
    chip.title = s.label;
    const n = document.createElement("b");
    n.textContent = s.n;
    const text = document.createElement("span");
    text.textContent = s.label;
    chip.append(n, text);
    chip.addEventListener("click", () => openSource(s));
    box.append(chip);
  }
  metaEl.before(box);
}

// =====================================================================
// Карточки инструментов
// =====================================================================

const STATUS_TEXT = {
  running: "выполняю…", waiting: "ждёт вашего решения", ok: "готово", error: "ошибка",
  declined: "отклонено", cancelled: "остановлено",
};

/** Вопрос в карточке подтверждения — человеческими словами. */
function confirmQuestion(entry) {
  const a = entry.arguments || {};
  switch (entry.name) {
    case "read_file": return `Прочитать файл «${a.path}» из вашей папки?`;
    case "list_files": return `Посмотреть список файлов в «${a.path || "."}»${a.recursive ? " (со вложенными папками)" : ""}?`;
    case "run_python": return "Запустить этот код в песочнице?";
    case "web_search": return `Искать в интернете: «${a.query}»? Запрос уйдёт поисковику.`;
    case "open_url": return `Открыть страницу ${a.url}?`;
    default: return `Выполнить «${entry.title}»?`;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pre(text, extra = "") {
  return el("pre", `t-out ${extra}`.trim(), text);
}

function codeBlock(code) {
  const box = el("div");
  box.innerHTML = renderMarkdown("```python\n" + code + "\n```");
  enhanceCodeBlocks(box, { highlight: true });
  return box;
}

function createToolCard(entry) {
  // Статус — классом с префиксом st- (класс «waiting» уже занят индикатором «Думаю…»)
  const card = el("div", "tool-card st-running");
  card.dataset.tool = entry.name;
  card.dataset.status = "running";
  const head = el("div", "tool-head");
  head.append(el("span", "t-icon", entry.icon || "🛠️"), el("span", "t-title", entry.title || entry.name));
  const summary = el("span", "t-summary", entry.summary || "");
  summary.title = entry.summary || "";
  const status = el("span", "t-status", STATUS_TEXT.running);
  head.append(summary, status);
  card.append(head);

  const setStatus = (name) => {
    card.className = `tool-card st-${name}`;
    card.dataset.status = name;
    status.textContent = STATUS_TEXT[name];
  };

  return {
    element: card,

    askConfirm(e, onAnswer) {
      setStatus("waiting");
      const box = el("div", "tool-confirm");
      box.append(el("p", "", confirmQuestion(e)));
      if (e.name === "run_python") box.append(codeBlock(e.arguments?.code || ""));
      const actions = el("div", "t-actions");
      const allow = el("button", "btn btn-primary", "Разрешить");
      const deny = el("button", "btn", "Отклонить");
      allow.type = deny.type = "button";
      const answer = async (approved) => {
        allow.disabled = deny.disabled = true;
        const ok = await onAnswer(approved);
        if (ok) {
          box.remove();
          setStatus(approved ? "running" : "declined");
        } else {
          allow.disabled = deny.disabled = false;
        }
      };
      allow.addEventListener("click", () => answer(true));
      deny.addEventListener("click", () => answer(false));
      actions.append(allow, deny);
      box.append(actions);
      card.append(box);
      allow.focus();
    },

    /** Ответ остановили, пока инструмент выполнялся или ждал решения. */
    cancel() {
      if (!["running", "waiting"].includes(card.dataset.status)) return;
      card.querySelector(".tool-confirm")?.remove();
      setStatus("cancelled");
    },

    setResult(e) {
      card.querySelector(".tool-confirm")?.remove();
      setStatus(e.status);
      if (e.duration && e.status === "ok") status.textContent = `готово · ${e.duration} с`;
      // Калькулятор показываем прямо в строке: «(2+3)^2 = 25»
      if (e.name === "calculator" && e.status === "ok") {
        summary.textContent = `${e.display.expression} = ${e.display.result}`;
        return;
      }
      const body = renderToolBody(e);
      if (!body) return;
      const details = el("details", "tool-body");
      details.append(el("summary", "", e.status === "ok" ? "Результат" : "Подробности"), body);
      if (e.status === "error") details.open = true;
      card.append(details);
    },
  };
}

/** Содержимое карточки после выполнения — своё для каждого инструмента. */
function renderToolBody(e) {
  const box = el("div", "tool-inner");
  const d = e.display || {};
  if (e.status === "declined") {
    box.append(el("span", "t-label", "Вы отклонили это действие — ассистент ответил без него."));
    if (e.name === "run_python" && e.arguments?.code) box.append(codeBlock(e.arguments.code));
    return box;
  }
  if (e.status === "error") {
    box.append(pre(d.error || "Неизвестная ошибка", "t-err"));
    return box;
  }
  switch (e.name) {
    case "web_search": {
      const list = el("ul", "t-results");
      for (const r of d.results || []) {
        const li = el("li");
        const a = el("a", "", r.title || r.url);
        a.href = r.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.append(a, el("div", "t-url", r.url), el("div", "t-snippet", r.snippet));
        list.append(li);
      }
      if (!d.results?.length) box.append(el("span", "t-label", "Ничего не найдено."));
      box.append(list);
      break;
    }
    case "open_url": {
      const a = el("a", "", d.title || d.url);
      a.href = d.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const list = el("ul", "t-results");
      const li = el("li");
      li.append(a, el("div", "t-url", d.url));
      list.append(li);
      box.append(list, pre(d.content + (d.truncated ? "\n…" : "")));
      break;
    }
    case "list_files": {
      const ul = el("ul", "t-files");
      for (const entry of d.entries || []) ul.append(el("li", "", entry.path));
      box.append(el("span", "t-label", `Папка: ${d.path}`), ul);
      if (d.truncated) box.append(el("span", "t-label", "Показана часть списка."));
      break;
    }
    case "read_file":
      box.append(el("span", "t-label", `${d.path} · ${d.chars} символов${d.truncated ? " · модель получила начало файла" : ""}`),
        pre(d.content + (d.chars > (d.content || "").length ? "\n…" : "")));
      break;
    case "run_python":
      box.append(codeBlock(d.code || ""));
      if (d.stdout) box.append(el("span", "t-label", "Вывод"), pre(d.stdout));
      if (d.stderr) box.append(el("span", "t-label", "Ошибки"), pre(d.stderr, "t-err"));
      if (d.timed_out) box.append(el("span", "t-label", "Код не уложился в лимит времени и был остановлен."));
      if (d.files?.length) box.append(el("span", "t-label", `Созданные файлы (удалены вместе с песочницей): ${d.files.map((f) => f.name).join(", ")}`));
      box.append(el("span", "t-label", `Код завершения: ${d.exit_code} · ${d.duration} с`));
      break;
    default:
      box.append(pre(JSON.stringify(d, null, 2)));
  }
  return box;
}

const NOTE_ICONS = { add: "💾", update: "✏️", delete: "🗑️" };

function memoryNote(ev, onUndo) {
  const note = document.createElement("div");
  note.className = "memory-note" + (ev.undone ? " undone" : "");
  const { label, text } = describeEvent(ev);
  const span = document.createElement("span");
  span.className = "note-text";
  span.innerHTML = `${NOTE_ICONS[ev.action]} <b></b> `;
  span.querySelector("b").textContent = `${label}:`;
  span.append(text);
  note.append(span);
  if (ev.undone) {
    note.append(" · отменено");
  } else if (onUndo) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn small";
    btn.textContent = "Отменить";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const updated = await onUndo(ev);
      if (updated) note.replaceWith(memoryNote(updated, onUndo));
      else btn.disabled = false;
    });
    note.append(" · ", btn);
  }
  return note;
}

/** Рисует всю историю диалога. Кнопка «Повторить» — только у последнего ответа. */
export function renderHistory(messages, { onRetry, memoryEvents = [], onUndoMemory } = {}) {
  clearMessages();
  if (!messages.length) return;
  // События памяти по id ответа, после которого они случились (в журнале — от новых к старым)
  const eventsByMessage = new Map();
  for (const ev of [...memoryEvents].reverse()) {
    if (!eventsByMessage.has(ev.message_id)) eventsByMessage.set(ev.message_id, []);
    eventsByMessage.get(ev.message_id).push(ev);
  }
  let lastAssistant = null;
  for (const m of messages) {
    if (m.role === "user") {
      addUserMessage(m.content);
    } else if (m.role === "assistant") {
      lastAssistant = createAssistantMessage({ onRetry });
      for (const entry of m.extras?.tools || []) lastAssistant.toolResult(entry); // карточки инструментов
      lastAssistant.finish({ message: m });
      lastAssistant.showMemoryEvents(eventsByMessage.get(m.id), onUndoMemory);
    }
  }
  if (lastAssistant && messages.at(-1).role === "assistant") lastAssistant.setRetryVisible(true);
  scrollToBottom(true);
}

/** Убирает у всех ответов кнопку «Повторить» (перед новым запросом). */
export function hideAllRetryButtons() {
  messagesEl().querySelectorAll(".btn-retry").forEach((b) => (b.hidden = true));
}

/** Удаляет последний ответ ассистента из окна (перед «Повторить»). */
export function removeLastAssistantMessage() {
  const all = messagesEl().querySelectorAll(".msg");
  const last = all[all.length - 1];
  if (last?.classList.contains("msg-assistant")) last.remove();
}
