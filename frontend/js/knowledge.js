// =====================================================================
// Страница «База знаний»: загрузка файлов, подключение папки (Obsidian),
// список коллекций и документов с прогрессом индексации, проверка поиска.
// Плюс окно просмотра источника, которое открывается по клику на [1] в ответе.
// =====================================================================

import { api } from "./api.js";
import { enhanceCodeBlocks, renderMarkdown } from "./markdown.js";
import { plural } from "./memory.js";

const $ = (id) => document.getElementById(id);

const ICONS = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

let data = null; // последний ответ GET /api/knowledge
let pollTimer = null;
let onChange = () => {};

const fmtDate = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function initKnowledgePage({ onChanged } = {}) {
  onChange = onChanged || (() => {});

  // --- загрузка файлов: выбор и перетаскивание ---
  const drop = $("kb-dropzone");
  $("kb-file-input").addEventListener("change", (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = ""; // чтобы можно было выбрать тот же файл ещё раз
  });
  for (const ev of ["dragenter", "dragover"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
  }
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadFiles([...e.dataTransfer.files]);
  });

  $("kb-upload-collection").addEventListener("change", async (e) => {
    if (e.target.value !== "new") return;
    const name = prompt("Название новой коллекции (например, «Алгоритмы» или «Английский»):");
    if (name?.trim()) {
      const c = await api.createCollection(name.trim());
      await refreshKnowledgePage();
      $("kb-upload-collection").value = c.id;
    } else {
      e.target.selectedIndex = 0;
    }
  });

  // --- подключение папки ---
  $("kb-folder-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const path = $("kb-folder-path").value.trim();
    if (!path) return;
    showError("kb-folder-error", null);
    try {
      await api.addFolder(path);
    } catch (err) {
      showError("kb-folder-error", err.message);
      return;
    }
    $("kb-folder-path").value = "";
    refreshKnowledgePage();
  });

  // --- проверка поиска ---
  $("kb-search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("kb-search-input").value.trim();
    if (q) renderSearch(q, await api.searchKnowledge(q).catch((err) => ({ error: err.message })));
  });

  // --- окно источника ---
  $("source-close").addEventListener("click", () => $("source-dialog").close());
  $("source-dialog").addEventListener("click", (e) => {
    if (e.target === $("source-dialog")) $("source-dialog").close();
  });
}

function showError(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text || "";
}

async function uploadFiles(files) {
  if (!files.length) return;
  showError("kb-upload-error", null);
  const target = $("kb-upload-collection").value;
  try {
    const result = await api.uploadFiles(files, target && target !== "new" ? target : null);
    if (result.errors.length) showError("kb-upload-error", result.errors.join("\n"));
  } catch (err) {
    showError("kb-upload-error", err.message);
  }
  refreshKnowledgePage();
}

/** Загружает состояние базы знаний и перерисовывает страницу. Пока идёт индексация — опрашивает каждую секунду. */
export async function refreshKnowledgePage() {
  clearTimeout(pollTimer);
  try {
    data = await api.knowledge();
  } catch (e) {
    $("kb-stats").textContent = `Не удалось загрузить базу знаний: ${e.message}`;
    return;
  }
  renderStats();
  renderUploadTargets();
  renderCollections();
  onChange(data);
  const visible = !$("knowledge-view").hidden;
  if (data.stats.in_progress > 0 && visible) pollTimer = setTimeout(refreshKnowledgePage, 1000);
}

function renderStats() {
  const s = data.stats;
  const el = $("kb-stats");
  el.innerHTML = "";
  const parts = [plural(s.documents, "документ", "документа", "документов"), plural(s.chunks, "фрагмент", "фрагмента", "фрагментов")];
  if (s.in_progress) parts.push(`<span class="warn">индексируется: ${s.in_progress}</span>`);
  if (data.embedding.available) {
    parts.push(`<span class="ok">поиск по смыслу: ${escapeHtml(data.embedding.model)}</span>`);
  } else {
    parts.push(`поиск по смыслу выключен — скачайте модель: <code>ollama pull ${escapeHtml(data.embedding.model)}</code> (пока работает поиск по словам)`);
  }
  el.innerHTML = parts.join(" · ");
  const missing = s.chunks - s.chunks_with_vectors;
  if (missing > 0 && data.embedding.available && !s.in_progress) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    btn.textContent = ` Досчитать векторы (${missing})`;
    btn.addEventListener("click", async () => {
      await api.reembed();
      refreshKnowledgePage();
    });
    el.append(" · ", btn);
  }
}

function renderUploadTargets() {
  const select = $("kb-upload-collection");
  const previous = select.value;
  select.innerHTML = "";
  const uploads = data.collections.filter((c) => c.kind === "upload");
  if (!uploads.length) select.append(new Option("Мои файлы (создастся)", ""));
  for (const c of uploads) select.append(new Option(c.name, c.id));
  select.append(new Option("+ Новая коллекция…", "new"));
  if ([...select.options].some((o) => o.value === previous && previous !== "new")) select.value = previous;
}

function renderCollections() {
  const box = $("kb-collections");
  box.innerHTML = "";
  if (!data.collections.length) {
    box.innerHTML = '<div class="memory-empty">Пока пусто. Загрузите конспекты, учебники или подключите папку с заметками — и спрашивайте по ним в чате.</div>';
    return;
  }
  for (const c of data.collections) box.append(renderCollection(c));
}

function renderCollection(c) {
  const el = document.createElement("section");
  el.className = "kb-collection";
  const head = document.createElement("div");
  head.className = "kb-collection-head";
  const icon = document.createElement("span");
  icon.className = "c-icon";
  icon.textContent = c.kind === "folder" ? "📁" : "🗂️";
  const info = document.createElement("div");
  info.className = "c-info";
  const name = document.createElement("div");
  name.className = "c-name";
  name.textContent = c.name;
  const meta = document.createElement("div");
  meta.className = "c-meta";
  const metaParts = [plural(c.document_count, "документ", "документа", "документов"), plural(c.chunk_count, "фрагмент", "фрагмента", "фрагментов")];
  if (c.kind === "folder") metaParts.unshift(c.path);
  if (c.synced_at) metaParts.push(`синхронизировано ${fmtDate(c.synced_at)}`);
  meta.textContent = metaParts.join(" · ");
  meta.title = meta.textContent;
  info.append(name, meta);
  head.append(icon, info);

  if (c.kind === "folder") {
    head.append(button("Синхронизировать", "btn", async (btn) => {
      btn.disabled = true;
      btn.textContent = "Синхронизирую…";
      try {
        const r = await api.syncCollection(c.id);
        btn.textContent = `+${r.added} ~${r.updated} −${r.removed}`;
      } catch (err) {
        alert(err.message);
      }
      setTimeout(refreshKnowledgePage, 600);
    }));
  }
  head.append(
    button("Переименовать", "btn", async () => {
      const newName = prompt("Новое название коллекции:", c.name);
      if (newName?.trim()) {
        await api.renameCollection(c.id, newName.trim());
        refreshKnowledgePage();
      }
    }),
    button("Удалить", "btn btn-danger-text", async () => {
      const what = c.kind === "folder" ? "Файлы в папке на диске не пострадают — удалится только индекс." : "Загруженные файлы будут удалены.";
      if (!confirm(`Удалить коллекцию «${c.name}» из базы знаний? ${what}`)) return;
      await api.deleteCollection(c.id);
      refreshKnowledgePage();
    }),
  );

  const docs = document.createElement("div");
  docs.className = "kb-docs";
  if (!c.documents.length) {
    docs.innerHTML = '<div class="kb-empty">В коллекции нет документов.</div>';
  }
  for (const d of c.documents) docs.append(renderDocument(d));
  el.append(head, docs);
  return el;
}

function renderDocument(d) {
  const row = document.createElement("div");
  row.className = "kb-doc";
  row.dataset.status = d.status;
  const type = document.createElement("span");
  type.className = `d-type ${d.file_type}`;
  type.textContent = d.file_type.toUpperCase();

  const body = document.createElement("div");
  body.className = "d-body";
  const title = document.createElement("div");
  title.className = "d-title";
  title.textContent = d.title;
  title.title = d.rel_path;
  const meta = document.createElement("div");
  meta.className = "d-meta";
  body.append(title, meta);

  if (d.status === "pending") {
    meta.textContent = "в очереди…";
  } else if (d.status === "indexing") {
    meta.textContent = d.chunk_count ? `считаю векторы: ${d.progress} из ${d.chunk_count}` : "читаю файл…";
    const bar = document.createElement("div");
    bar.className = "kb-progress";
    bar.innerHTML = `<span style="width:${d.chunk_count ? Math.round((d.progress / d.chunk_count) * 100) : 5}%"></span>`;
    body.append(bar);
  } else if (d.status === "error") {
    meta.className = "d-meta error";
    meta.textContent = d.error;
  } else {
    const parts = [];
    if (d.rel_path !== `${d.title}.${d.file_type}`) parts.push(d.rel_path);
    if (d.page_count) parts.push(plural(d.page_count, "страница", "страницы", "страниц"));
    parts.push(plural(d.chunk_count, "фрагмент", "фрагмента", "фрагментов"));
    meta.textContent = parts.join(" · ");
    if (d.error) { // у готового документа это предупреждение (например, нет модели эмбеддингов)
      const warn = document.createElement("div");
      warn.className = "d-meta warn";
      warn.textContent = d.error;
      body.append(warn);
    }
  }

  const actions = document.createElement("div");
  actions.className = "d-actions";
  const open = document.createElement("a");
  open.className = "icon-btn";
  open.href = `/api/knowledge/documents/${d.id}/file`;
  open.target = "_blank";
  open.rel = "noopener";
  open.title = "Открыть документ";
  open.innerHTML = ICONS.open;
  actions.append(
    open,
    iconButton("Переиндексировать", ICONS.retry, async () => {
      await api.reindexDocument(d.id);
      refreshKnowledgePage();
    }),
    iconButton("Удалить из базы знаний", ICONS.trash, async () => {
      if (!confirm(`Удалить «${d.title}» из базы знаний?`)) return;
      await api.deleteDocument(d.id);
      refreshKnowledgePage();
    }),
  );
  row.append(type, body, actions);
  return row;
}

function renderSearch(q, result) {
  const box = $("kb-search-results");
  box.innerHTML = "";
  if (result.error) {
    box.textContent = result.error;
    return;
  }
  const methods = { hybrid: "по смыслу и по словам", words: "только по словам", none: "ничего подходящего" };
  const head = document.createElement("p");
  head.className = "hint";
  head.textContent = `Найдено: ${result.results.length} (${methods[result.method] || result.method}). Именно эти фрагменты получит модель.`;
  box.append(head);
  for (const [i, hit] of result.results.entries()) {
    const el = document.createElement("div");
    el.className = "kb-hit";
    const h = document.createElement("div");
    h.className = "kb-hit-head";
    const b = document.createElement("b");
    b.textContent = `[${i + 1}] ${hit.title}`;
    h.append(b);
    const extra = [hit.section, hit.page_start ? `стр. ${hit.page_start}` : null,
      hit.score !== null ? `близость ${hit.score}` : null, hit.by_words ? "совпали слова" : null].filter(Boolean);
    if (extra.length) h.append(` · ${extra.join(" · ")}`);
    const t = document.createElement("div");
    t.className = "kb-hit-text";
    t.textContent = hit.text;
    el.append(h, t);
    box.append(el);
  }
}

// ---------- окно источника ----------

/** Показывает фрагмент-источник: текст и кнопку «Открыть документ» (PDF — сразу на нужной странице). */
export async function openSource(source) {
  const dialog = $("source-dialog");
  $("source-title").textContent = `[${source.n}] ${source.title}`;
  $("source-meta").textContent = [source.collection, source.section, source.page ? `стр. ${source.page}` : null].filter(Boolean).join(" · ");
  $("source-text").classList.remove("content");
  $("source-text").textContent = "Загружаю…";
  const open = $("source-open");
  open.href = `/api/knowledge/documents/${source.document_id}/file${source.file_type === "pdf" && source.page ? `#page=${source.page}` : ""}`;
  open.hidden = false;
  dialog.showModal();
  try {
    const chunk = await api.getChunk(source.chunk_id);
    const box = $("source-text");
    if (chunk.file_type === "md") {
      // Заметку показываем оформленной: заголовки, списки, подсветка кода
      box.classList.add("content");
      box.innerHTML = renderMarkdown(chunk.text);
      enhanceCodeBlocks(box);
    } else {
      box.classList.remove("content");
      box.textContent = chunk.text;
    }
  } catch (e) {
    $("source-text").textContent = e.message;
    open.hidden = true;
  }
}

function button(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
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
