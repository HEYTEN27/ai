// =====================================================================
// Боковая панель: список диалогов, сгруппированный по датам.
// =====================================================================

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

/** В какую группу попадает диалог: «Сегодня», «Вчера», «7 дней», «Ранее». */
function groupName(isoDate) {
  const date = new Date(isoDate);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (date >= startOfToday) return "Сегодня";
  if (date >= startOfToday - dayMs) return "Вчера";
  if (date >= startOfToday - 7 * dayMs) return "Последние 7 дней";
  return "Ранее";
}

/**
 * Рисует список диалогов.
 * handlers: { onOpen(id), onRename(id, title), onDelete(id) }
 */
export function renderConversationList(conversations, activeId, handlers) {
  const list = document.getElementById("conv-list");
  list.innerHTML = "";

  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "conv-empty";
    empty.textContent = "Пока нет диалогов";
    list.append(empty);
    return;
  }

  let currentGroup = null;
  for (const conv of conversations) {
    const group = groupName(conv.updated_at);
    if (group !== currentGroup) {
      currentGroup = group;
      const g = document.createElement("div");
      g.className = "conv-group";
      g.textContent = group;
      list.append(g);
    }
    list.append(createItem(conv, conv.id === activeId, handlers));
  }
}

function createItem(conv, isActive, { onOpen, onRename, onDelete }) {
  const item = document.createElement("div");
  item.className = "conv-item" + (isActive ? " active" : "");

  const title = document.createElement("button");
  title.type = "button";
  title.className = "conv-title";
  title.textContent = conv.title;
  title.title = conv.title;
  title.addEventListener("click", () => onOpen(conv.id));
  title.addEventListener("dblclick", () => startRename());

  const actions = document.createElement("div");
  actions.className = "conv-actions";
  const editBtn = iconButton(ICONS.edit, "Переименовать", () => startRename());
  const deleteBtn = iconButton(ICONS.trash, "Удалить", () => {
    if (confirm(`Удалить диалог «${conv.title}»? Это нельзя отменить.`)) onDelete(conv.id);
  });
  actions.append(editBtn, deleteBtn);
  item.append(title, actions);

  // Переименование прямо в списке: заменяем название на поле ввода
  function startRename() {
    const input = document.createElement("input");
    input.value = conv.title;
    input.maxLength = 200;
    item.replaceChildren(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (save && value && value !== conv.title) onRename(conv.id, value);
      else item.replaceChildren(title, actions);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  return item;
}

function iconButton(svg, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = svg;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
