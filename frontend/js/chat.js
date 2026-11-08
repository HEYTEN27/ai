// =====================================================================
// Отрисовка сообщений в окне чата.
// =====================================================================

import { copyText, enhanceCodeBlocks, renderMarkdown } from "./markdown.js";
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
     */
    finish({ message, stopped = false, error = null, memoryFacts = null } = {}) {
      msg.classList.remove("streaming", "streaming-wait");
      if (message) {
        content = message.content ?? content;
        thinking = message.thinking ?? thinking;
      }
      contentEl.innerHTML = renderMarkdown(content);
      enhanceCodeBlocks(contentEl, { highlight: true });
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
