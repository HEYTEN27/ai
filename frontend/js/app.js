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
  setMemoryLookup,
  setPersonaLookup,
} from "./chat.js";
import { initDatasetPage, refreshDatasetPage } from "./dataset.js";
import { initKnowledgePage, refreshKnowledgePage } from "./knowledge.js";
import { initMemoryPage, refreshMemoryPage } from "./memory.js";
import { initSettings } from "./settings.js";
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
  personas: [], // персоны (учитель, программист...)
  memoryById: new Map(), // факты памяти по id — для подсказки «что учтено в ответе»
  view: "chat", // что показано в основной области: chat | memory
  defaultPersonaId: null, // персона для новых чатов (из настроек)
  abortController: null, // не null, пока идёт генерация (для кнопки «Стоп»)
  lastStatus: null,
};

// ---------- элементы страницы ----------
const $ = (id) => document.getElementById(id);
const input = $("input");
const sendBtn = $("send-btn");
const modelSelect = $("model-select");
const personaSelect = $("persona-select");
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

// =====================================================================
// Персоны
// =====================================================================

async function loadPersonas() {
  try {
    const [personas, settings] = await Promise.all([api.listPersonas(), api.getSettings()]);
    state.personas = personas;
    state.defaultPersonaId = settings.values.default_persona_id ?? personas[0]?.id ?? null;
  } catch {
    state.personas = [];
  }
  const previous = personaSelect.value;
  personaSelect.innerHTML = "";
  for (const p of state.personas) {
    const opt = new Option(`${p.icon} ${p.name}`, p.id);
    opt.title = p.description;
    personaSelect.append(opt);
  }
  // Оставляем выбранную персону, если она ещё существует
  setPersonaSelect(previous ? Number(previous) : state.defaultPersonaId);
}

function setPersonaSelect(id) {
  const exists = state.personas.some((p) => p.id === id);
  personaSelect.value = exists ? id : (state.defaultPersonaId ?? "");
}

function selectedPersonaId() {
  return personaSelect.value ? Number(personaSelect.value) : null;
}

// Под ответом показываем, какой персоной он написан
setPersonaLookup((id) => state.personas.find((p) => p.id === id));

personaSelect.addEventListener("change", async () => {
  // В открытом диалоге запоминаем персону на сервере; для нового чата она применится при создании
  if (state.activeId) {
    await api.updateConversation(state.activeId, { persona_id: selectedPersonaId() }).catch(() => {});
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
    setPersonaSelect(conv.persona_id ?? state.defaultPersonaId);
    setKnowledgeScope(conv.kb_scope || "all");
    if (conv.model && state.models.has(conv.model)) {
      modelSelect.value = conv.model;
      updateThinkToggle();
    }
    showChatView();
    renderHistory(conv.messages, {
      onRetry: regenerate,
      memoryEvents: conv.memory_events,
      onUndoMemory: undoMemoryEvent,
    });
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
  showChatView();
  setHash(null);
  setPersonaSelect(state.defaultPersonaId);
  setKnowledgeScope("all");
  clearMessages();
  refreshConversations();
  closeSidebar();
  input.focus();
}

// =====================================================================
// Страница «Память»
// =====================================================================

// Кэш фактов: id → текст. Нужен, чтобы под старыми ответами показать, какие факты были учтены.
async function loadMemoryCache() {
  try {
    const data = await api.listMemory();
    state.memoryById = new Map(data.items.map((m) => [m.id, m.content]));
  } catch {
    /* память недоступна — подсказки просто будут без текста */
  }
}
setMemoryLookup((id) => state.memoryById.get(id));

// Страницы, которые показываются вместо чата: адрес, секция, кнопка в боковой панели, обновление
const PAGES = {
  memory: { hash: "#/memory", view: "memory-view", button: "memory-btn", refresh: () => refreshMemoryPage() },
  knowledge: { hash: "#/knowledge", view: "knowledge-view", button: "knowledge-btn", refresh: () => refreshKnowledgePage() },
  dataset: { hash: "#/dataset", view: "dataset-view", button: "dataset-btn", refresh: () => refreshDatasetPage() },
};

function showPage(name) {
  if (state.abortController) stopGeneration();
  hidePages();
  state.view = name;
  const page = PAGES[name];
  document.querySelector(".main").classList.add(`show-${name}`);
  $(page.view).hidden = false;
  $(page.button).classList.add("active");
  history.replaceState(null, "", page.hash);
  state.activeId = null;
  refreshConversations(); // снять подсветку открытого диалога
  closeSidebar();
  page.refresh();
}

function hidePages() {
  for (const [name, page] of Object.entries(PAGES)) {
    document.querySelector(".main").classList.remove(`show-${name}`);
    $(page.view).hidden = true;
    $(page.button).classList.remove("active");
  }
}

function showChatView() {
  if (state.view === "chat") return;
  state.view = "chat";
  hidePages();
  refreshKnowledgeScope(); // могли добавить документы — обновим выбор базы знаний
}

$("memory-btn").addEventListener("click", () => showPage("memory"));
$("knowledge-btn").addEventListener("click", () => showPage("knowledge"));
$("dataset-btn").addEventListener("click", () => showPage("dataset"));
initDatasetPage();

function pageFromHash() {
  return Object.keys(PAGES).find((name) => PAGES[name].hash === location.hash) || null;
}

// Адрес поменяли вручную или кнопкой «Назад» — открываем нужное.
// (Наши собственные переходы идут через history.replaceState и это событие не вызывают.)
window.addEventListener("hashchange", () => {
  const id = idFromHash();
  const page = pageFromHash();
  if (page) showPage(page);
  else if (id && id !== state.activeId) openConversation(id);
  else if (!location.hash) newChat();
});

// =====================================================================
// База знаний: где искать ответы в этом диалоге
// =====================================================================

const kbScope = $("kb-scope");

/** Варианты: вся база / одна коллекция / без базы. Строка видна, только если есть готовые документы. */
function fillKnowledgeScope(overview) {
  const ready = overview?.stats?.ready > 0;
  $("kb-scope-row").hidden = !ready;
  if (!ready) return;
  const previous = kbScope.value || "all";
  kbScope.innerHTML = "";
  kbScope.append(new Option("Искать в базе знаний", "all"));
  const withDocs = overview.collections.filter((c) => c.documents.some((d) => d.status === "ready"));
  if (withDocs.length > 1) {
    for (const c of withDocs) kbScope.append(new Option(`Только «${c.name}»`, String(c.id)));
  }
  kbScope.append(new Option("Без базы знаний", "off"));
  setKnowledgeScope(previous);
}

function setKnowledgeScope(value) {
  kbScope.value = [...kbScope.options].some((o) => o.value === value) ? value : "all";
}

async function refreshKnowledgeScope() {
  fillKnowledgeScope(await api.knowledge().catch(() => null));
}

kbScope.addEventListener("change", async () => {
  if (state.activeId) {
    await api.updateConversation(state.activeId, { kb_scope: kbScope.value }).catch(() => {});
  }
});

initKnowledgePage({ onChanged: fillKnowledgeScope });
initMemoryPage({ onChanged: loadMemoryCache });

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
      const conv = await api.createConversation({ model, persona_id: selectedPersonaId(), kb_scope: kbScope.value || "all" });
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
  let released = false;
  let memoryFacts = null;
  let sources = null; // фрагменты базы знаний для ссылок [1], [2]

  // Ответ готов → поле ввода снова доступно. Поток при этом ещё открыт:
  // сервер может прислать событие memory («Запомнил: …») через пару секунд.
  const release = () => {
    if (released) return;
    released = true;
    if (state.abortController === controller) state.abortController = null;
    setGenerating(false);
    bubble.setRetryVisible(true);
    pollStatusNow(); // модель только что загрузилась — обновим индикатор VRAM
    refreshConversations(); // название диалога могло обновиться
  };

  const onEvent = (event, data) => {
    if ((event === "token" || event === "thinking") && !started) {
      started = true;
      bubble.startStreaming();
    }
    if (event === "start") {
      memoryFacts = data.memory?.facts || [];
      sources = data.knowledge?.sources || [];
    }
    else if (event === "thinking") bubble.appendThinking(data.text);
    else if (event === "token") bubble.appendContent(data.text);
    else if (event === "done") {
      finished = true;
      bubble.finish({ message: data.message, memoryFacts, sources });
      release();
    } else if (event === "error") {
      finished = true;
      bubble.finish({ message: data.partial, error: data.message, memoryFacts, sources });
      release();
    } else if (event === "tool_start") {
      bubble.toolStart(data);
    } else if (event === "tool_confirm") {
      bubble.toolConfirm(data, async (approved) => {
        try {
          await api.confirmTool(data.id, approved);
          return true;
        } catch (e) {
          alert(e.message);
          return false;
        }
      });
    } else if (event === "tool_result") {
      bubble.toolResult(data);
    } else if (event === "memory") {
      bubble.showMemoryEvents(data.events, undoMemoryEvent);
      loadMemoryCache();
    }
  };

  try {
    await startRequest(onEvent, controller.signal);
    if (!finished) bubble.finish({ error: "Соединение прервалось до конца ответа." });
  } catch (e) {
    if (finished) {
      /* ответ уже показан — обрыв во время ожидания памяти не страшен */
    } else if (e.name === "AbortError") bubble.finish({ stopped: true, memoryFacts, sources });
    else bubble.finish({ error: e.message, memoryFacts, sources });
  } finally {
    release();
  }
}

/** Отмена изменения памяти из чата. Возвращает обновлённое событие (или null при ошибке). */
async function undoMemoryEvent(ev) {
  try {
    const updated = await api.undoMemoryEvent(ev.id);
    loadMemoryCache();
    return updated;
  } catch (e) {
    alert(e.message);
    return null;
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
    applyAssistantName(health.assistant_name);
    return health.ok;
  } catch {
    renderConnection({ ok: false });
    return false;
  }
}

/** Подставляет имя ассистента (из настроек сервера) в заголовок, логотип и приветствие. */
function applyAssistantName(name) {
  if (!name) return;
  document.title = name;
  $("assistant-name").textContent = name;
  $("greeting").textContent = `${name} на связи. Чем помочь?`;
  $("knowledge-sub").textContent =
    `Документы, по которым ${name} отвечает со ссылками на источник. Всё хранится и обрабатывается на этом компьютере.`;
  $("memory-sub").textContent =
    `Что ${name} знает о вас. Подходящие факты подставляются в ответы. Всё хранится только на этом компьютере.`;
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
  await Promise.all([loadModels(), loadPersonas(), loadMemoryCache(), refreshKnowledgeScope()]);
  await refreshConversations();

  initSettings({
    getModels: () => state.models,
    getPersonas: () => state.personas,
    // После сохранения настроек: новое имя, список персон, модель по умолчанию
    onSaved: async () => {
      await Promise.all([checkHealth(), loadPersonas()]);
      if (state.activeId) {
        const conv = await api.getConversation(state.activeId).catch(() => null);
        if (conv) setPersonaSelect(conv.persona_id ?? state.defaultPersonaId);
      }
    },
  });

  const id = idFromHash();
  const page = pageFromHash();
  if (page) showPage(page);
  else if (id) await openConversation(id);
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
