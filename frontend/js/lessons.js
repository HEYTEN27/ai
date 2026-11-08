// =====================================================================
// Уроки (этап 11): раздел на странице «Память» и отметки «📘 Урок» в чате.
// Урок — правило, как отвечать пользователю, выведенное из исправления или 👎.
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);
const SOURCES = { correction: "из исправления", feedback: "из 👎", manual: "вручную" };
const fmtDate = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

export async function refreshLessons() {
  let data;
  let settings;
  try {
    [data, settings] = await Promise.all([api.lessons(), api.getSettings()]);
  } catch (e) {
    $("lessons-list").textContent = `Не удалось загрузить уроки: ${e.message}`;
    return;
  }
  $("lessons-enabled").checked = settings.values.lessons_enabled;
  const list = $("lessons-list");
  list.innerHTML = "";
  if (!data.items.length) {
    const empty = document.createElement("p");
    empty.className = "lessons-empty";
    empty.textContent = "Уроков пока нет. Исправьте ответ (✏️) или поставьте 👎 и выберите причину — Джарвис сделает выводы.";
    list.append(empty);
    return;
  }
  for (const lesson of data.items) list.append(lessonRow(lesson));
}

function lessonRow(lesson) {
  const row = document.createElement("div");
  row.className = "lesson-item" + (lesson.enabled ? "" : " is-off");
  row.dataset.id = lesson.id;

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = lesson.enabled;
  toggle.title = lesson.enabled ? "Урок применяется — снимите, чтобы выключить" : "Урок выключен";
  toggle.setAttribute("aria-label", "Применять урок");
  toggle.addEventListener("change", async () => {
    await api.updateLesson(lesson.id, { enabled: toggle.checked }).catch((e) => alert(e.message));
    refreshLessons();
  });

  const body = document.createElement("div");
  body.className = "lesson-body";
  const text = document.createElement("span");
  text.className = "lesson-text";
  text.textContent = lesson.content;
  const meta = document.createElement("span");
  meta.className = "lesson-meta";
  meta.textContent = `${SOURCES[lesson.source] || lesson.source} · ${fmtDate(lesson.updated_at)}`;
  body.append(text, meta);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "link-btn small";
  edit.textContent = "Изменить";
  edit.addEventListener("click", () => startEdit(row, lesson));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "link-btn small danger";
  del.textContent = "Удалить";
  del.addEventListener("click", async () => {
    await api.deleteLesson(lesson.id).catch((e) => alert(e.message));
    refreshLessons();
  });
  row.append(toggle, body, edit, del);
  return row;
}

function startEdit(row, lesson) {
  const body = row.querySelector(".lesson-body");
  const input = document.createElement("input");
  input.className = "lesson-edit";
  input.maxLength = 300;
  input.value = lesson.content;
  body.replaceWith(input);
  input.focus();
  const finish = async (save) => {
    if (save && input.value.trim() && input.value.trim() !== lesson.content) {
      await api.updateLesson(lesson.id, { content: input.value.trim() }).catch((e) => alert(e.message));
    }
    refreshLessons();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true), { once: true });
}

export function initLessons() {
  $("lessons-enabled").addEventListener("change", (e) => {
    api.updateSettings({ lessons_enabled: e.target.checked }).catch((err) => alert(err.message));
  });
  $("lesson-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = $("lesson-add-text").value.trim();
    if (!content) return;
    try {
      await api.addLesson(content);
      $("lesson-add-text").value = "";
    } catch (err) {
      alert(err.message);
    }
    refreshLessons();
  });
}

// ---------- в чате ----------

/**
 * Запросить урок и показать результат под ответом: «📘 Урок: «…» · Отменить».
 * box — элемент, куда положить отметку (создаётся рядом с кнопками под ответом).
 */
export async function learnAndShow(box, payload) {
  const note = document.createElement("div");
  note.className = "lesson-note is-pending";
  note.textContent = "📘 Делаю выводы на будущее…";
  box.append(note);
  let r;
  try {
    r = await api.learnLesson(payload);
  } catch (e) {
    note.className = "lesson-note is-none";
    note.textContent = `📘 Не получилось: ${e.message}`;
    return;
  }
  renderNote(note, r);
}

function renderNote(note, r) {
  note.innerHTML = "";
  if (r.action === "none") {
    note.className = "lesson-note is-none";
    note.textContent = `📘 ${r.note || "Урока из этого не вышло."}`;
    return;
  }
  note.className = "lesson-note";
  const label = document.createElement("b");
  label.textContent = r.action === "updated" ? "Урок обновлён:" : "Урок:";
  const text = document.createElement("span");
  text.textContent = ` «${r.lesson.content}» `;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "link-btn small";
  undo.textContent = "Отменить";
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    try {
      if (r.action === "added") await api.deleteLesson(r.lesson.id);
      else await api.updateLesson(r.lesson.id, { content: r.previous });
    } catch (e) {
      alert(e.message);
      undo.disabled = false;
      return;
    }
    note.className = "lesson-note is-none";
    note.textContent = "📘 Урок отменён";
  });
  note.append("📘 ", label, text, "· ", undo);
}
