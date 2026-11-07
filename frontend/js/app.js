// =====================================================================
// Главный файл интерфейса: связывает все части вместе.
//
// Состояние приложения хранится в одном объекте state. Когда что-то
// меняется (открыли диалог, пришёл ответ), мы обновляем state и
// перерисовываем нужную часть экрана.
// =====================================================================

import { api } from "./api.js";
import {
  addUserMessage,
  clearMessages,
  createAssistantMessage,
  hideAllRetryButtons,
  removeLastAssistantMessage,
  renderHistory,
} from "./chat.js";
import { renderConversationList } from "./sidebar.js";
import {
  fillModelSelect,
  renderBanner,
  renderConnection,
  renderVram,
  startStatusPolling,
  vramWarning,
} from "./status.js";

const state = {
  conversations: [], // список диалогов для боковой панели
  activeId: null, // открытый диалог (null = новый, ещё не созданный)
  models: new Map(), // скачанные модели по имени
  abortController: null, // не null, пока идёт генерация (для кнопки «Стоп»)
  lastStatus: null,
};

// ---------- элементы страницы ----------
const $ = (id) => document.getElementById(id);
const input = $("input");
const sendBtn = $("send-btn");
const modelSelect = $("model-select");
const thinkToggle = $("think-toggle");
const thinkWrap = $("think-toggle-wrap");

// ---------- localStorage: запоминаем выбор модели и переключателя ----------
// Обёрнуто в try/catch: в приватном режиме браузера хранилище может быть недоступно.
const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* не страшно — просто не запомним */
    }
  },
};

// =====================================================================
// Модели
// =====================================================================

async function loadModels() {
  try {
    const data = await api.models();
    const preferred = prefs.get("model", null) || data.default_model;
    state.models = fillModelSelect(modelSelect, data.models, preferred);
    if (!data.models.length) {
      renderBanner({
        html: "В Ollama нет ни одной модели для чата. Скачайте основную модель командой <code>ollama pull qwen3:8b</code> и обновите страницу.",
      });
    }
  } catch (e) {
    state.models = fillModelSelect(modelSelect, [], null);
    renderBanner({
      error: true,
      html: `${escapeHtml(e.message)}<br>После запуска Ollama обновите страницу.`,
    });
  }
  updateThinkToggle();
}

function selectedModel() {
  return modelSelect.value || null;
}

/** Переключатель «Размышлять» показываем только для моделей, которые это умеют (Qwen3). */
function updateThinkToggle() {
  const model = state.models.get(selectedModel());
  thinkWrap.hidden = !model?.supports_thinking;
}

modelSelect.addEventListener("change", async () => {
  prefs.set("model", selectedModel());
  updateThinkToggle();
  if (state.lastStatus) renderVram(state.lastStatus, selectedModel());
  // Запоминаем выбор модели в открытом диалоге
  if (state.activeId) {
    await api.updateConversation(state.activeId, { model: selectedModel() }).catch(() => {});
  }
});

thinkToggle.checked = prefs.get("think", false);
thinkToggle.addEventListener("change", () => prefs.set("think", thinkToggle.checked));

// =====================================================================
// Диалоги
// =====================================================================

async function refreshConversations() {
  try {
    state.conversations = await api.listConversations();
  } catch {
    state.conversations = [];
  }
  renderConversationList(state.conversations, state.activeId, {
    onOpen: (id) => openConversation(id),
    onRename: async (id, title) => {
      await api.updateConversation(id, { title });
      refreshConversations();
    },
    onDelete: async (id) => {
      await api.deleteConversation(id);
      if (id === state.activeId) newChat();
      else refreshConversations();
    },
  });
}

async function openConversation(id) {
  if (state.abortController) stopGeneration();
  try {
    const conv = await api.getConversation(id);
    state.activeId = conv.id;
    setHash(conv.id);
    if (conv.model && state.models.has(conv.model)) {
      modelSelect.value = conv.model;
      updateThinkToggle();
    }
    renderHistory(conv.messages, { onRetry: regenerate });
  } catch {
    // Диалог удалён или ссылка устарела — открываем новый
    newChat();
    return;
  }
  closeSidebar();
  refreshConversations();
  input.focus();
}

function newChat() {
  if (state.abortController) stopGeneration();
  state.activeId = null;
  setHash(null);
  clearMessages();
  refreshConversations();
  closeSidebar();
  input.focus();
}

// Адрес вида #/c/<id> — чтобы после обновления страницы открылся тот же диалог
function setHash(id) {
  const hash = id ? `#/c/${id}` : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
}

function idFromHash() {
  const m = location.hash.match(/^#\/c\/([\w-]+)$/);
  return m ? m[1] : null;
}

// =====================================================================
// Отправка сообщения и потоковый ответ
// =====================================================================

async function sendMessage(text) {
  text = text.trim();
  if (!text || state.abortController) return;
  const model = selectedModel();
  if (!model) {
    renderBanner({ error: true, html: "Не выбрана модель. Скачайте её: <code>ollama pull qwen3:8b</code>" });
    return;
  }

  // Новый диалог создаём на сервере только при первом сообщении
  if (!state.activeId) {
    try {
      const conv = await api.createConversation({ model });
      state.activeId = conv.id;
      setHash(conv.id);
    } catch (e) {
      alert(`Не удалось создать диалог: ${e.message}`);
      return;
    }
  }

  input.value = "";
  autoResize();
  hideAllRetryButtons();
  addUserMessage(text);

  await streamAnswer((onEvent, signal) =>
    api.sendMessage(state.activeId, { content: text, model, think: thinkToggle.checked }, onEvent, signal),
  );
  refreshConversations(); // название диалога могло обновиться
}

/** «Ответить заново»: удаляем последний ответ и генерируем новый (можно другой моделью). */
async function regenerate() {
  if (!state.activeId || state.abortController) return;
  removeLastAssistantMessage();
  hideAllRetryButtons();
  const model = selectedModel();
  await streamAnswer((onEvent, signal) =>
    api.regenerate(state.activeId, { model, think: thinkToggle.checked }, onEvent, signal),
  );
}

/**
 * Общая логика потокового ответа.
 * startRequest(onEvent, signal) — функция, которая запускает нужный запрос.
 */
async function streamAnswer(startRequest) {
  const bubble = createAssistantMessage({ onRetry: regenerate });
  const loaded = state.lastStatus?.loaded?.some((m) => m.name === selectedModel());
  bubble.setWaiting(loaded ? "Думаю…" : "Загружаю модель в видеопамять…");

  const controller = new AbortController();
  state.abortController = controller;
  setGenerating(true);

  let finished = false;
  let started = false;
  const onEvent = (event, data) => {
    if ((event === "token" || event === "thinking") && !started) {
      started = true;
      bubble.startStreaming();
    }
    if (event === "thinking") bubble.appendThinking(data.text);
    else if (event === "token") bubble.appendContent(data.text);
    else if (event === "done") {
      finished = true;
      bubble.finish({ message: data.message });
    } else if (event === "error") {
      finished = true;
      bubble.finish({ message: data.partial, error: data.message });
    }
  };

  try {
    await startRequest(onEvent, controller.signal);
    if (!finished) bubble.finish({ error: "Соединение прервалось до конца ответа." });
  } catch (e) {
    if (e.name === "AbortError") bubble.finish({ stopped: true });
    else bubble.finish({ error: e.message });
  } finally {
    state.abortController = null;
    setGenerating(false);
    bubble.setRetryVisible(true);
    pollStatusNow(); // модель только что загрузилась — обновим индикатор VRAM
  }
}

function stopGeneration() {
  state.abortController?.abort();
}

/** Кнопка отправки превращается в «Стоп» на время генерации. */
function setGenerating(on) {
  sendBtn.classList.toggle("is-stop", on);
  sendBtn.setAttribute("aria-label", on ? "Остановить" : "Отправить");
  updateSendButton();
}

function updateSendButton() {
  sendBtn.disabled = !state.abortController && !input.value.trim();
}

// =====================================================================
// Поле ввода
// =====================================================================

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
  updateSendButton();
}

input.addEventListener("input", autoResize);
input.addEventListener("keydown", (e) => {
  // Enter — отправить, Shift+Enter — перенос строки.
  // isComposing — не мешаем вводу через IME (например, китайская раскладка)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.abortController) sendMessage(input.value);
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.abortController) stopGeneration();
  else sendMessage(input.value);
});

document.querySelectorAll(".suggestion").forEach((btn) => {
  btn.addEventListener("click", () => sendMessage(btn.textContent));
});

$("new-chat-btn").addEventListener("click", newChat);

// Esc останавливает генерацию
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.abortController) stopGeneration();
});

// ---------- боковая панель на телефоне ----------
function closeSidebar() {
  $("sidebar").classList.remove("open");
}
$("menu-btn").addEventListener("click", () => $("sidebar").classList.add("open"));
$("sidebar-backdrop").addEventListener("click", closeSidebar);

// =====================================================================
// Состояние Ollama и VRAM
// =====================================================================

function onStatus(status) {
  state.lastStatus = status;
  renderVram(status, selectedModel());
  if (!status.ok || !state.models.size) return; // тут плашку показывает loadModels()
  // Предупреждаем только про выбранную модель: другая могла остаться в памяти с прошлого раза
  const warning = vramWarning(status, selectedModel());
  if (warning) renderBanner({ text: warning });
  else renderBanner(); // всё хорошо — прячем плашку
}

async function pollStatusNow() {
  try {
    onStatus(await api.status());
  } catch {
    /* ignore */
  }
}

async function checkHealth() {
  try {
    const health = await api.health();
    renderConnection(health);
    return health.ok;
  } catch {
    renderConnection({ ok: false });
    return false;
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// =====================================================================
// Запуск
// =====================================================================

async function init() {
  const ok = await checkHealth();
  await loadModels();
  await refreshConversations();

  const id = idFromHash();
  if (id) await openConversation(id);
  else input.focus();

  let polling = ok ? startStatusPolling(onStatus) : null;
  // Раз в 15 секунд проверяем связь с Ollama (вдруг её запустили или закрыли)
  let wasOk = ok;
  setInterval(async () => {
    const nowOk = await checkHealth();
    if (nowOk && !wasOk) {
      // Ollama появилась — подтягиваем модели и включаем индикатор VRAM
      renderBanner();
      await loadModels();
      polling ??= startStatusPolling(onStatus);
    }
    wasOk = nowOk;
  }, 15000);
}

init();
