// =====================================================================
// Страница «Датасет»: прогресс, экспорт в JSONL, список примеров
// с правкой, исключением и удалением.
// =====================================================================

import { api } from "./api.js";
import { plural } from "./memory.js";

const $ = (id) => document.getElementById(id);
let filter = "all";

export function initDatasetPage() {
  $("ds-filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".ds-filter");
    if (!btn) return;
    filter = btn.dataset.filter;
    document.querySelectorAll(".ds-filter").forEach((b) => b.classList.toggle("active", b === btn));
    refreshDatasetPage();
  });
  for (const el of [...document.querySelectorAll('input[name="ds-format"]'), $("ds-system"), $("ds-tools")]) {
    el.addEventListener("change", updateDownloadLink);
  }
  updateDownloadLink();
}

/** Ссылка «Скачать JSONL» с выбранными параметрами. */
function updateDownloadLink() {
  const format = document.querySelector('input[name="ds-format"]:checked').value;
  const params = new URLSearchParams({ format, system: $("ds-system").checked, tools: $("ds-tools").checked });
  $("ds-download").href = `/api/dataset/export?${params}`;
  $("ds-download").setAttribute("download", `jarvis_${format}.jsonl`);
}

export async function refreshDatasetPage() {
  let data;
  try {
    data = await api.dataset(filter);
  } catch (e) {
    $("ds-summary").textContent = `Не удалось загрузить датасет: ${e.message}`;
    return;
  }
  renderProgress(data);
  renderList(data.items);
}

function renderProgress({ stats, files }) {
  $("ds-count").textContent = stats.in_sft;
  // «1 пример», «2 примера», «5 примеров» — plural возвращает «N слово», число уже показано отдельно
  $("ds-count-word").textContent = `${plural(stats.in_sft, "пример", "примера", "примеров").split(" ")[1]} для обучения`;
  $("ds-target").textContent = `желательно ${stats.target}+ для заметного эффекта`;
  $("ds-bar-fill").style.width = `${Math.min(100, (stats.in_sft / stats.target) * 100)}%`;
  const parts = [
    `всего оценено: ${stats.total}`, `👍 ${stats.good}`, `👎 ${stats.bad}`, `✏️ ${stats.corrected}`,
    `пар для DPO: ${stats.dpo_pairs}`, `≈ ${stats.tokens.toLocaleString("ru-RU")} токенов`,
  ];
  if (stats.with_tools) parts.push(`с инструментами: ${stats.with_tools} (по умолчанию не в обучении)`);
  $("ds-summary").textContent = parts.join(" · ");
  $("ds-files").textContent = `Файлы обновляются сами: ${files.sft}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderList(items) {
  const list = $("ds-list");
  list.innerHTML = "";
  if (!items.length) {
    list.append(el("div", "memory-empty", filter === "all"
      ? "Пока пусто. Отмечайте хорошие ответы 👍 и исправляйте плохие ✏️ — так соберётся датасет."
      : "В этом фильтре ничего нет."));
    return;
  }
  for (const item of items) list.append(renderItem(item));
}

/** Почему пример не попадает в обучение — понятными словами. */
function whyExcluded(e) {
  if (!e.included) return "исключён вами";
  if (e.used_tools) return "ответ с инструментами";
  if (e.rating === -1) return "👎 без исправления";
  return "нет оценки";
}

function renderItem(e) {
  const item = el("article", "ds-item" + (e.in_sft ? "" : " excluded"));
  item.dataset.id = e.id;
  const head = el("div", "ds-item-head");
  head.append(el("span", `ds-badge ${e.in_sft ? "in" : "out"}`, e.in_sft ? "в обучении" : `не в обучении: ${whyExcluded(e)}`));
  if (e.rating === 1) head.append(el("span", "ds-badge", "👍"));
  if (e.rating === -1) head.append(el("span", "ds-badge", "👎"));
  if (e.corrected) head.append(el("span", "ds-badge", "✏️ исправлен"));
  if (e.used_tools) head.append(el("span", "ds-badge", "🛠 инструменты"));
  if (e.strip_citations) head.append(el("span", "ds-badge", "ссылки [n] будут вырезаны"));
  const when = new Date(e.updated_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  head.append(`${e.persona || ""} · ${e.model || ""} · ${when}` + (e.history.length ? ` · +${plural(e.history.length, "сообщение", "сообщения", "сообщений")} контекста` : ""));

  // Вопрос без фрагментов базы знаний — они длинные, показываем только суть
  const question = e.question.includes("Вопрос пользователя:") ? e.question.split("Вопрос пользователя:").pop().trim() : e.question;
  const q = el("div", "ds-q", question);
  item.append(head, q);

  if (e.corrected) {
    item.append(el("div", "ds-a-label", "Исправленный ответ (образец):"), el("div", "ds-a corrected", e.corrected),
      el("div", "ds-a-label", "Исходный ответ модели:"), el("div", "ds-a", e.answer));
  } else {
    item.append(el("div", "ds-a", e.answer));
  }

  const actions = el("div", "ds-item-actions");
  const toggle = el("button", "btn", e.included ? "Исключить" : "Вернуть в датасет");
  toggle.type = "button";
  toggle.addEventListener("click", async () => {
    await api.updateExample(e.id, { included: !e.included });
    refreshDatasetPage();
  });
  const edit = el("button", "btn", e.corrected ? "Изменить исправление" : "Исправить ответ");
  edit.type = "button";
  edit.addEventListener("click", () => startEdit(item, e));
  const del = el("button", "btn btn-danger-text", "Удалить");
  del.type = "button";
  del.addEventListener("click", async () => {
    if (!confirm("Удалить пример из датасета? Оценка в чате тоже снимется.")) return;
    await api.deleteExample(e.id);
    refreshDatasetPage();
  });
  actions.append(toggle, edit, del);
  if (e.conversation_id) {
    const open = el("a", "link-btn small", "открыть диалог");
    open.href = `#/c/${e.conversation_id}`;
    actions.append(el("span", "spacer"), open);
  }
  item.append(actions);
  return item;
}

function startEdit(item, e) {
  if (item.querySelector(".ds-edit")) return;
  const box = el("div", "ds-edit");
  const textarea = document.createElement("textarea");
  textarea.value = e.corrected || e.answer;
  textarea.rows = Math.min(16, Math.max(5, textarea.value.split("\n").length + 1));
  textarea.setAttribute("aria-label", "Исправленный ответ");
  const row = el("div", "ds-item-actions");
  const save = el("button", "btn btn-primary", "Сохранить");
  const cancel = el("button", "btn", "Отмена");
  save.type = cancel.type = "button";
  save.addEventListener("click", async () => {
    const value = textarea.value.trim();
    await api.updateExample(e.id, { corrected: value === e.answer.trim() ? "" : value });
    refreshDatasetPage();
  });
  cancel.addEventListener("click", () => box.remove());
  row.append(save, cancel);
  box.append(textarea, row);
  item.querySelector(".ds-item-actions").before(box);
  textarea.focus();
}
