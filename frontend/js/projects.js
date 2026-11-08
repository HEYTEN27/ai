// =====================================================================
// Проекты (этап 15а): список проектов и страница проекта — инструкции,
// файлы, чаты и «Новый чат в проекте».
// =====================================================================

import { api } from "./api.js";
import { describeFile, fileIcon } from "./attachments.js";

const $ = (id) => document.getElementById(id);
let current = null; // открытый проект (с чатами и файлами)
let handlers = { onOpenChat: () => {}, onNewChat: () => {}, onChanged: () => {} };

export let projectsById = new Map(); // id → проект; для значков в списке диалогов

export async function loadProjects() {
  try {
    const list = await api.listProjects();
    projectsById = new Map(list.map((p) => [p.id, p]));
    return list;
  } catch {
    return [];
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
}

async function renderList() {
  $("projects-list-view").hidden = false;
  $("project-detail").hidden = true;
  const list = await loadProjects();
  const grid = $("projects-grid");
  grid.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "lessons-empty";
    empty.textContent = "Проектов пока нет. Создайте первый — например, «Курсовая» или «Подготовка к сессии».";
    grid.append(empty);
    return;
  }
  for (const p of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "project-card";
    card.dataset.id = p.id;
    const icon = document.createElement("span");
    icon.className = "pc-icon";
    icon.textContent = p.icon;
    const name = document.createElement("span");
    name.className = "pc-name";
    name.textContent = p.name;
    const meta = document.createElement("span");
    meta.className = "pc-meta";
    meta.textContent = `${plural(p.chats, "чат", "чата", "чатов")} · ${plural(p.files, "файл", "файла", "файлов")}`;
    card.append(icon, name, meta);
    card.addEventListener("click", () => openProject(p.id));
    grid.append(card);
  }
}

export async function openProject(id) {
  try {
    current = await api.getProject(id);
  } catch (e) {
    alert(e.message);
    return renderList();
  }
  $("projects-list-view").hidden = true;
  $("project-detail").hidden = false;
  $("project-icon").value = current.icon;
  $("project-name").value = current.name;
  $("project-instructions").value = current.instructions;
  $("project-saved").textContent = "";
  renderFiles();
  renderChats();
}

function renderFiles() {
  const box = $("project-files");
  box.innerHTML = "";
  if (!current.files.length) {
    box.textContent = "Файлов пока нет.";
    box.classList.add("is-empty");
    return;
  }
  box.classList.remove("is-empty");
  for (const f of current.files) {
    const row = document.createElement("div");
    row.className = "project-file";
    const name = document.createElement("a");
    name.href = f.url;
    name.download = f.name;
    name.textContent = `${fileIcon(f.name)} ${f.name}`;
    const info = document.createElement("span");
    info.className = "hint";
    info.textContent = describeFile(f);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link-btn small danger";
    del.textContent = "удалить";
    del.addEventListener("click", async () => {
      if (!confirm(`Убрать «${f.name}» из проекта?`)) return;
      await api.deleteFile(f.id).catch((e) => alert(e.message));
      openProject(current.id);
    });
    row.append(name, info, del);
    box.append(row);
  }
}

function renderChats() {
  const box = $("project-chats");
  box.innerHTML = "";
  if (!current.conversations.length) {
    box.textContent = "Чатов пока нет — нажмите «Новый чат в проекте».";
    return;
  }
  for (const c of current.conversations) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "project-chat";
    btn.textContent = c.title;
    btn.addEventListener("click", () => handlers.onOpenChat(c.id));
    box.append(btn);
  }
}

async function saveProject() {
  try {
    current = { ...current, ...(await api.updateProject(current.id, {
      name: $("project-name").value.trim() || current.name, icon: $("project-icon").value.trim() || "📁",
      instructions: $("project-instructions").value,
    })) };
    $("project-saved").textContent = "Сохранено ✓";
    handlers.onChanged();
  } catch (e) {
    alert(e.message);
  }
}

export function refreshProjectsPage() {
  if (current && !$("project-detail").hidden) return openProject(current.id);
  return renderList();
}

export function initProjectsPage(opts) {
  handlers = { ...handlers, ...opts };
  $("project-new-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("project-new-name").value.trim();
    if (!name) return;
    try {
      const p = await api.createProject({ name, icon: $("project-new-icon").value.trim() || "📁" });
      $("project-new-name").value = "";
      handlers.onChanged();
      openProject(p.id);
    } catch (err) {
      alert(err.message);
    }
  });
  $("project-back").addEventListener("click", () => {
    current = null;
    renderList();
  });
  $("project-save").addEventListener("click", saveProject);
  $("project-new-chat").addEventListener("click", () => handlers.onNewChat(current));
  $("project-add-file").addEventListener("click", () => $("project-file-input").click());
  $("project-file-input").addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      try {
        await api.uploadProjectFile(current.id, file);
      } catch (err) {
        alert(`${file.name}: ${err.message}`);
      }
    }
    e.target.value = "";
    openProject(current.id);
  });
  $("project-delete").addEventListener("click", async () => {
    if (!confirm(`Удалить проект «${current.name}»? Чаты останутся (без проекта), файлы проекта удалятся.`)) return;
    await api.deleteProject(current.id).catch((err) => alert(err.message));
    current = null;
    handlers.onChanged();
    renderList();
  });
}
