// =====================================================================
// Общение с нашим сервером (FastAPI).
// Обычные запросы — через fetch и JSON, ответ модели — потоком (SSE).
// =====================================================================

/** Обычный JSON-запрос. При ошибке бросает Error с понятным текстом от сервера. */
export async function request(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await errorText(response));
  }
  return response.status === 204 ? null : response.json();
}

async function errorText(response) {
  try {
    const data = await response.json();
    // FastAPI кладёт текст ошибки в поле detail (строка или список ошибок валидации)
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) return data.detail.map((d) => d.msg).join("; ");
  } catch {
    /* ответ не JSON — ниже вернём код статуса */
  }
  return `Ошибка сервера: ${response.status}`;
}

/**
 * Отправляет запрос и читает ответ в формате Server-Sent Events.
 *
 * Почему не EventSource: он умеет только GET-запросы, а нам нужен POST с телом.
 * Поэтому читаем поток вручную: response.body — это ReadableStream байтов.
 *
 * @param {string} url
 * @param {object} body
 * @param {(event: string, data: object) => void} onEvent — вызывается на каждое событие
 * @param {AbortSignal} signal — чтобы кнопка «Стоп» могла оборвать запрос
 */
export async function streamSSE(url, body, onEvent, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(await errorText(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // stream: true — правильно склеивает русские буквы, разрезанные между кусками
    buffer += decoder.decode(value, { stream: true });

    // События разделяются пустой строкой. Последний кусок может быть неполным —
    // оставляем его в буфере до следующего чтения.
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop();
    for (const block of blocks) {
      const parsed = parseBlock(block);
      if (parsed) onEvent(parsed.event, parsed.data);
    }
  }
}

function parseBlock(block) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data: JSON.parse(data) };
}

// ---------- удобные обёртки над конкретными эндпоинтами ----------

export const api = {
  health: () => request("GET", "/api/health"),
  models: () => request("GET", "/api/models"),
  status: () => request("GET", "/api/status"),

  listConversations: () => request("GET", "/api/conversations"),
  createConversation: (data = {}) => request("POST", "/api/conversations", data),
  getConversation: (id) => request("GET", `/api/conversations/${id}`),
  updateConversation: (id, data) => request("PATCH", `/api/conversations/${id}`, data),
  deleteConversation: (id) => request("DELETE", `/api/conversations/${id}`),

  getSettings: () => request("GET", "/api/settings"),
  updateSettings: (changes) => request("PUT", "/api/settings", changes),
  vramEstimate: (params) => request("GET", `/api/settings/vram-estimate?${new URLSearchParams(params)}`),

  listPersonas: () => request("GET", "/api/personas"),
  createPersona: (data) => request("POST", "/api/personas", data),
  updatePersona: (id, data) => request("PUT", `/api/personas/${id}`, data),
  resetPersona: (id) => request("POST", `/api/personas/${id}/reset`),
  deletePersona: (id) => request("DELETE", `/api/personas/${id}`),

  listMemory: (q) => request("GET", `/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  addMemory: (data) => request("POST", "/api/memory", data),
  updateMemory: (id, data) => request("PUT", `/api/memory/${id}`, data),
  deleteMemory: (id) => request("DELETE", `/api/memory/${id}`),
  clearMemory: () => request("DELETE", "/api/memory?confirm=yes"),
  memoryEvents: (limit = 50) => request("GET", `/api/memory/events?limit=${limit}`),
  undoMemoryEvent: (id) => request("POST", `/api/memory/events/${id}/undo`),

  knowledge: () => request("GET", "/api/knowledge"),
  createCollection: (name) => request("POST", "/api/knowledge/collections", { name }),
  renameCollection: (id, name) => request("PATCH", `/api/knowledge/collections/${id}`, { name }),
  deleteCollection: (id) => request("DELETE", `/api/knowledge/collections/${id}`),
  addFolder: (path) => request("POST", "/api/knowledge/folders", { path }),
  syncCollection: (id) => request("POST", `/api/knowledge/collections/${id}/sync`),
  deleteDocument: (id) => request("DELETE", `/api/knowledge/documents/${id}`),
  reindexDocument: (id) => request("POST", `/api/knowledge/documents/${id}/reindex`),
  getChunk: (id) => request("GET", `/api/knowledge/chunks/${id}`),
  searchKnowledge: (q) => request("GET", `/api/knowledge/search?q=${encodeURIComponent(q)}`),
  reembed: () => request("POST", "/api/knowledge/reembed"),
  /** Загрузка файлов: multipart/form-data, поэтому не через request() с JSON. */
  async uploadFiles(files, collectionId) {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    if (collectionId) form.append("collection_id", collectionId);
    const response = await fetch("/api/knowledge/upload", { method: "POST", body: form });
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  },

  listTools: () => request("GET", "/api/tools"),
  confirmTool: (id, approved) => request("POST", `/api/tools/confirm/${id}`, { approved }),
  checkFolder: (path) => request("GET", `/api/tools/files/check?path=${encodeURIComponent(path)}`),

  trainingStatus: () => request("GET", "/api/training/status"),
  voiceStatus: () => request("GET", "/api/voice/status"),
  /** Распознавание речи: запись отправляем как файл (multipart). */
  async transcribe(blob) {
    const form = new FormData();
    form.append("audio", blob, blob.type.includes("ogg") ? "voice.ogg" : "voice.webm");
    const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  },

  rateMessage: (messageId, rating) => request("POST", "/api/dataset/feedback", { message_id: messageId, rating }),
  correctMessage: (messageId, corrected) => request("POST", "/api/dataset/correct", { message_id: messageId, corrected }),
  dataset: (filter = "all") => request("GET", `/api/dataset?filter=${filter}`),
  updateExample: (id, data) => request("PATCH", `/api/dataset/${id}`, data),
  deleteExample: (id) => request("DELETE", `/api/dataset/${id}`),

  /** Вложение в чат: файл уходит на сервер сразу, текст из него извлекается там же. */
  async uploadAttachment(file) {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/files", { method: "POST", body: form });
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  },
  deleteFile: (id) => request("DELETE", `/api/files/${id}`),

  lessons: () => request("GET", "/api/lessons"),
  addLesson: (content) => request("POST", "/api/lessons", { content }),
  updateLesson: (id, data) => request("PATCH", `/api/lessons/${id}`, data),
  deleteLesson: (id) => request("DELETE", `/api/lessons/${id}`),
  learnLesson: (data) => request("POST", "/api/lessons/learn", data),
  runPython: (code) => request("POST", "/api/tools/run-python", { code }),

  sendMessage: (id, body, onEvent, signal) =>
    streamSSE(`/api/conversations/${id}/messages`, body, onEvent, signal),
  regenerate: (id, body, onEvent, signal) =>
    streamSSE(`/api/conversations/${id}/regenerate`, body, onEvent, signal),
};
