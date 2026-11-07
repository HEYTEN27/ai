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

  sendMessage: (id, body, onEvent, signal) =>
    streamSSE(`/api/conversations/${id}/messages`, body, onEvent, signal),
  regenerate: (id, body, onEvent, signal) =>
    streamSSE(`/api/conversations/${id}/regenerate`, body, onEvent, signal),
};
