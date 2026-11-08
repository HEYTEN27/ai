// =====================================================================
// Поиск по всем диалогам (этап 15а): Ctrl+K, совпадения подсвечены,
// Enter или клик — открыть диалог на найденном сообщении.
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);
let timer = null;
let results = []; // [{conversation_id, message_id?, ...}]
let selected = 0;
let onOpen = () => {};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Сниппет от сервера: текст с метками \u0001…\u0002 вокруг совпадений → безопасный HTML с <mark>. */
function snippetHtml(snippet) {
  return escapeHtml(snippet).replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
}

function render(data) {
  const box = $("search-results");
  box.innerHTML = "";
  results = [
    ...data.conversations.map((c) => ({ conversation_id: c.id, title: c.title, kind: "title" })),
    ...data.messages.map((m) => ({ ...m, kind: "message" })),
  ];
  selected = 0;
  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = $("search-input").value.trim().length < 2 ? "Введите хотя бы два символа" : "Ничего не найдено";
    box.append(empty);
    return;
  }
  results.forEach((r, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-item";
    item.dataset.index = i;
    const title = document.createElement("span");
    title.className = "si-title";
    title.textContent = (r.kind === "title" ? "💬 " : r.role === "user" ? "🧑 " : "🤖 ") + r.title;
    item.append(title);
    if (r.kind === "message") {
      const snip = document.createElement("span");
      snip.className = "si-snippet";
      snip.innerHTML = snippetHtml(r.snippet);
      item.append(snip);
    }
    item.addEventListener("click", () => choose(i));
    item.addEventListener("mousemove", () => highlight(i));
    box.append(item);
  });
  highlight(0);
}

function highlight(i) {
  selected = i;
  $("search-results").querySelectorAll(".search-item").forEach((el) => el.classList.toggle("is-active", Number(el.dataset.index) === i));
  $("search-results").querySelector(".search-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function choose(i) {
  const r = results[i];
  if (!r) return;
  $("search-dialog").close();
  onOpen(r.conversation_id, r.message_id || null);
}

async function run() {
  const q = $("search-input").value.trim();
  if (q.length < 2) return render({ conversations: [], messages: [] });
  try {
    render(await api.search(q));
  } catch {
    render({ conversations: [], messages: [] });
  }
}

export function openSearch() {
  const dialog = $("search-dialog");
  if (!dialog.open) dialog.showModal();
  $("search-input").select();
  run();
}

export function initSearch({ onOpenResult }) {
  onOpen = onOpenResult;
  $("search-btn").addEventListener("click", openSearch);
  $("search-input").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 180);
  });
  $("search-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(results.length - 1, selected + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(0, selected - 1)); }
    if (e.key === "Enter") { e.preventDefault(); choose(selected); }
  });
  $("search-dialog").addEventListener("click", (e) => { if (e.target === $("search-dialog")) $("search-dialog").close(); });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { // Ctrl+K (в русской раскладке — «л», но key всё равно k)
      e.preventDefault();
      openSearch();
    }
  });
}
