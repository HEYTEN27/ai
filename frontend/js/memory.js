// =====================================================================
// Страница «Память»: факты о пользователе — просмотр, поиск, правка,
// закрепление, удаление, ручное добавление, журнал изменений с отменой.
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

let data = null; // последний ответ GET /api/memory
let searchTimer = null;
let onChange = () => {};

const fmtDate = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

/** «3 факта», «5 фактов» — русские окончания. */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function initMemoryPage({ onChanged } = {}) {
  onChange = onChanged || (() => {});

  $("memory-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshMemoryPage, 200);
  });

  $("memory-add-btn").addEventListener("click", () => {
    $("memory-add-form").hidden = false;
    $("memory-add-text").focus();
  });
  $("memory-add-cancel").addEventListener("click", closeAddForm);
  $("memory-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = $("memory-add-text").value.trim();
    if (!content) return;
    try {
      await api.addMemory({
        content,
        category: $("memory-add-category").value,
        pinned: $("memory-add-pinned").checked,
      });
    } catch (err) {
      alert(err.message);
      return;
    }
    closeAddForm();
    await refreshMemoryPage();
  });

  // Переключатели сохраняются сразу — это обычные настройки
  for (const [id, key] of [["mem-enabled", "memory_enabled"], ["mem-autosave", "memory_autosave"]]) {
    $(id).addEventListener("change", async (e) => {
      // Доступность «Запоминать автоматически» меняем сразу, не дожидаясь ответа сервера
      $("mem-autosave").disabled = !$("mem-enabled").checked;
      await api.updateSettings({ [key]: e.target.checked });
      await refreshMemoryPage();
    });
  }
  $("mem-budget").addEventListener("change", async (e) => {
    await api.updateSettings({ memory_budget_tokens: Number(e.target.value) });
    await refreshMemoryPage();
  });

  $("memory-clear").addEventListener("click", async () => {
    if (!data?.stats.count) return;
    if (!confirm(`Стереть все ${plural(data.stats.count, "факт", "факта", "фактов")} и журнал? Это нельзя отменить.`)) return;
    await api.clearMemory();
    await refreshMemoryPage();
  });

  $("memory-journal").addEventListener("toggle", (e) => {
    if (e.target.open) renderJournal();
  });
}

function closeAddForm() {
  $("memory-add-form").hidden = true;
  $("memory-add-text").value = "";
  $("memory-add-pinned").checked = false;
}

/** Загружает факты и перерисовывает страницу. */
export async function refreshMemoryPage() {
  try {
    data = await api.listMemory($("memory-search").value.trim());
  } catch (e) {
    $("memory-list").innerHTML = "";
    $("memory-stats").textContent = `Не удалось загрузить память: ${e.message}`;
    return;
  }
  // Категории для формы добавления (один раз)
  const catSelect = $("memory-add-category");
  if (!catSelect.options.length) {
    for (const c of data.categories) catSelect.append(new Option(c, c));
    catSelect.value = "другое";
  }
  $("mem-enabled").checked = data.settings.memory_enabled;
  $("mem-autosave").checked = data.settings.memory_autosave;
  $("mem-autosave").disabled = !data.settings.memory_enabled;
  setBudgetSelect(data.settings.memory_budget_tokens);
  renderStats();
  renderList();
  if ($("memory-journal").open) renderJournal();
  onChange();
}

function setBudgetSelect(value) {
  const select = $("mem-budget");
  if (![...select.options].some((o) => Number(o.value) === value)) {
    select.append(new Option(`${value} токенов`, value)); // значение задано не из списка
  }
  select.value = value;
}

function renderStats() {
  const { count, tokens, budget_tokens: budget } = data.stats;
  const el = $("memory-stats");
  if (!data.settings.memory_enabled) {
    el.innerHTML = '<span class="warn">Память выключена: факты не подставляются в ответы и не запоминаются.</span>';
    return;
  }
  const parts = [`${plural(count, "факт", "факта", "фактов")} · ≈ ${tokens} из ${budget} токенов`];
  if (tokens > budget) {
    // Все не влезают — объясняем, как выбираются факты
    const emb = data.embedding.available
      ? `<span class="ok">по смыслу (${escapeHtml(data.embedding.model)})</span>`
      : `по совпадению слов — для поиска по смыслу скачайте модель: <code>ollama pull ${escapeHtml(data.embedding.model)}</code>`;
    parts.push(`в ответ попадают закреплённые 📌 и самые подходящие к вопросу факты, подбор ${emb}`);
  } else if (count) {
    parts.push("все факты помещаются в контекст");
  }
  el.innerHTML = parts.join(" · ");
}

function renderList() {
  const list = $("memory-list");
  list.innerHTML = "";
  if (!data.items.length) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    empty.innerHTML = $("memory-search").value.trim()
      ? "Ничего не найдено."
      : "Пока пусто. Расскажите о себе в чате — например: «Я учусь на 2 курсе и пишу на JavaScript», — или добавьте факт вручную.";
    list.append(empty);
    return;
  }
  // Группы: сначала закреплённые, потом по категориям в порядке из списка категорий
  const groups = new Map([["📌 Закреплённые", []]]);
  for (const c of data.categories) groups.set(c, []);
  for (const m of data.items) groups.get(m.pinned ? "📌 Закреплённые" : m.category)?.push(m);

  for (const [name, items] of groups) {
    if (!items.length) continue;
    const group = document.createElement("section");
    group.className = "memory-group";
    const h = document.createElement("h3");
    h.textContent = name;
    group.append(h);
    for (const m of items) group.append(renderFact(m));
    list.append(group);
  }
}

function renderFact(m) {
  const row = document.createElement("div");
  row.className = "fact";
  row.dataset.id = m.id;

  const pin = iconButton(m.pinned ? "Открепить" : "Закрепить: подставлять в ответы всегда", "📌", async () => {
    await api.updateMemory(m.id, { pinned: !m.pinned });
    refreshMemoryPage();
  });
  pin.classList.add("pin");
  pin.classList.toggle("on", m.pinned);

  const body = document.createElement("div");
  body.className = "fact-body";
  const text = document.createElement("div");
  text.className = "fact-text";
  text.textContent = m.content;
  const meta = document.createElement("div");
  meta.className = "fact-meta";
  const metaParts = [m.pinned ? m.category : null, fmtDate(m.created_at)];
  metaParts.push(m.source === "manual" ? "добавлен вручную" : m.conversation_title ? `из диалога «${m.conversation_title}»` : "запомнен в диалоге");
  if (m.use_count) metaParts.push(`использован ${plural(m.use_count, "раз", "раза", "раз")}`);
  meta.textContent = metaParts.filter(Boolean).join(" · ");
  body.append(text, meta);

  const actions = document.createElement("div");
  actions.className = "fact-actions";
  actions.append(
    iconButton("Изменить", ICONS.edit, () => startEdit(row, m)),
    iconButton("Удалить", ICONS.trash, async () => {
      await api.deleteMemory(m.id);
      refreshMemoryPage(); // отменить можно в журнале
    }),
  );
  text.addEventListener("dblclick", () => startEdit(row, m));

  row.append(pin, body, actions);
  return row;
}

/** Правка факта прямо в списке. */
function startEdit(row, m) {
  const form = document.createElement("form");
  form.className = "fact-edit";
  form.innerHTML = `
    <textarea rows="2" maxlength="300" aria-label="Текст факта"></textarea>
    <div class="fact-form-row">
      <select aria-label="Категория"></select>
      <span class="spacer"></span>
      <button type="button" class="btn">Отмена</button>
      <button type="submit" class="btn btn-primary">Сохранить</button>
    </div>`;
  const textarea = form.querySelector("textarea");
  const select = form.querySelector("select");
  textarea.value = m.content;
  for (const c of data.categories) select.append(new Option(c, c));
  select.value = m.category;
  form.querySelector("button[type=button]").addEventListener("click", () => form.replaceWith(row));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
    if (e.key === "Escape") form.replaceWith(row);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.updateMemory(m.id, { content: textarea.value.trim(), category: select.value });
    } catch (err) {
      alert(err.message);
      return;
    }
    refreshMemoryPage();
  });
  row.replaceWith(form);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

/** Текст события памяти: «Запомнил: …», «Изменил: … → …», «Забыл: …». */
export function describeEvent(ev) {
  const who = ev.source === "manual" ? { add: "Добавлено", update: "Изменено", delete: "Удалено" }
    : { add: "Запомнил", update: "Обновил", delete: "Забыл" };
  if (ev.action === "update") return { label: who.update, text: `«${ev.old_content}» → «${ev.new_content}»` };
  if (ev.action === "add") return { label: who.add, text: `«${ev.new_content}»` };
  return { label: who.delete, text: `«${ev.old_content}»` };
}

async function renderJournal() {
  const box = $("memory-events");
  let events;
  try {
    events = await api.memoryEvents(100);
  } catch {
    box.textContent = "Не удалось загрузить журнал";
    return;
  }
  box.innerHTML = events.length ? "" : '<p class="hint">Журнал пуст.</p>';
  for (const ev of events) {
    const item = document.createElement("div");
    item.className = "journal-item" + (ev.undone ? " undone" : "");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(ev.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const what = document.createElement("span");
    what.className = "what";
    const { label, text } = describeEvent(ev);
    what.textContent = `${label}: ${text}`;
    item.append(when, what);
    if (!ev.undone) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "link-btn small";
      undo.textContent = "Отменить";
      undo.addEventListener("click", async () => {
        try {
          await api.undoMemoryEvent(ev.id);
        } catch (err) {
          alert(err.message);
        }
        refreshMemoryPage();
        renderJournal();
      });
      item.append(undo);
    } else {
      const done = document.createElement("span");
      done.className = "when";
      done.textContent = "отменено";
      item.append(done);
    }
    box.append(item);
  }
}

function iconButton(label, svg, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = svg;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
