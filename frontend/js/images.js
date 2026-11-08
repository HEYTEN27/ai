// =====================================================================
// Картинки (этап 13): страница «Изображения» (установка, модели, рисование,
// галерея), просмотрщик и карточка рисунков в чате с кнопкой «Ещё вариант».
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);
const ORIENT = { square: "квадрат", portrait: "портрет", landscape: "пейзаж" };
let status = null;
let pollTimer = null;

// ---------- рисование с прогрессом (общая часть для страницы и чата) ----------

/**
 * Нарисовать: POST /api/images/generate. Пока сервер рисует (десятки секунд), раз в 0,6 с
 * спрашиваем статус и передаём прогресс в onProgress({text, step, total}).
 */
export async function generateWithProgress(body, onProgress) {
  let done = false;
  const poll = async () => {
    while (!done) {
      try {
        const st = await api.imagesStatus();
        if (!done && st.progress) onProgress(st.progress);
      } catch {
        /* статус не пришёл — попробуем ещё раз */
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  };
  poll();
  try {
    return await api.imagesGenerate(body);
  } finally {
    done = true;
  }
}

/** Полоска прогресса: «Рисую: шаг 7 из 25». */
export function progressLine() {
  const box = document.createElement("div");
  box.className = "img-progress";
  box.innerHTML = '<div class="tts-bar"><div class="tts-bar-fill"></div></div><span class="hint"></span>';
  return {
    element: box,
    set(p) {
      box.querySelector(".hint").textContent = p.text || "";
      const pct = p.total ? Math.round(((p.step || 0) / p.total) * 100) : p.stage === "unload" ? 3 : p.stage === "load" ? 8 : 0;
      box.querySelector(".tts-bar-fill").style.width = `${pct}%`;
    },
  };
}

// ---------- просмотрщик ----------

let lightboxFile = null;
let lightboxHandlers = {};

export function openLightbox(file, handlers = {}) {
  lightboxFile = file;
  lightboxHandlers = handlers;
  const m = file.meta || {};
  $("lb-image").src = file.url;
  $("lb-image").alt = m.prompt || "";
  $("lb-request").textContent = m.request ? `«${m.request}»` : "";
  $("lb-request").hidden = !m.request;
  $("lb-prompt").textContent = m.prompt || "";
  $("lb-meta").textContent = [m.width && `${m.width}×${m.height}`, m.model, m.seed !== undefined && `seed ${m.seed}`,
    m.seconds && `${m.seconds} с`].filter(Boolean).join(" · ");
  $("lb-download").href = file.url;
  $("lb-download").download = file.name || "image.png";
  $("lb-more").hidden = !handlers.onMore;
  $("lb-delete").hidden = !handlers.onDelete;
  $("img-lightbox").showModal();
}

function initLightbox() {
  const dialog = $("img-lightbox");
  $("lb-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  $("lb-copy").addEventListener("click", () => navigator.clipboard?.writeText(lightboxFile?.meta?.prompt || "").catch(() => {}));
  $("lb-more").addEventListener("click", () => {
    dialog.close();
    lightboxHandlers.onMore?.(lightboxFile);
  });
  $("lb-delete").addEventListener("click", async () => {
    if (!confirm("Удалить картинку?")) return;
    try {
      await api.imagesDelete(lightboxFile.id);
    } catch (e) {
      alert(e.message);
      return;
    }
    dialog.close();
    lightboxHandlers.onDelete?.(lightboxFile);
  });
}

function thumb(file, onOpen) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "img-thumb";
  btn.title = file.meta?.prompt || "";
  const img = document.createElement("img");
  img.src = file.url;
  img.alt = file.meta?.prompt || "картинка";
  img.loading = "lazy";
  btn.append(img);
  btn.addEventListener("click", () => onOpen(file));
  return btn;
}

// ---------- карточка в чате ----------

/** Картинки в карточке инструмента generate_image + «Ещё вариант». */
export function imageResult(display, { toolId, getMessageId } = {}) {
  const box = document.createElement("div");
  box.className = "img-result";
  const grid = document.createElement("div");
  grid.className = "img-grid";
  const openOne = (file) => openLightbox(file, { onMore: () => more.click() });
  for (const file of display.images || []) grid.append(thumb(file, openOne));
  const row = document.createElement("div");
  row.className = "img-result-row";
  const caption = document.createElement("span");
  caption.className = "img-caption";
  caption.textContent = display.prompt || "";
  caption.title = display.prompt || "";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn btn-small img-more";
  more.textContent = "🎨 Ещё вариант";
  more.addEventListener("click", async () => {
    more.disabled = true;
    const progress = progressLine();
    row.after(progress.element);
    try {
      const r = await generateWithProgress({
        prompt: display.prompt, translate: false, orientation: display.orientation || "square",
        conversation_id: display.images?.[0]?.conversation_id || null, message_id: getMessageId?.() || null, tool_id: toolId || null,
      }, (p) => progress.set(p));
      for (const file of r.images) {
        display.images.push(file);
        grid.append(thumb(file, openOne));
      }
    } catch (e) {
      alert(e.message);
    } finally {
      progress.element.remove();
      more.disabled = false;
    }
  });
  row.append(caption, more);
  box.append(grid, row);
  return box;
}

// ---------- страница «Изображения» ----------

function renderSetup() {
  const st = status;
  const install = st.install;
  const installing = install && !install.finished;
  $("img-install").hidden = st.installed && !installing && !install?.error;
  $("img-install-text").textContent = installing
    ? `Устанавливаю PyTorch и diffusers (шаг ${install.step} из ${install.steps})… Это 5–15 минут, можно пользоваться чатом.`
    : install?.error || "Движок рисования (PyTorch с CUDA + diffusers, ≈ 3 ГБ) ещё не установлен. Ставится один раз.";
  $("img-install-btn").hidden = installing;
  $("img-log").hidden = !install?.log?.length;
  $("img-log").textContent = (install?.log || []).join("\n");

  const box = $("img-models");
  box.innerHTML = "";
  box.hidden = !st.installed;
  $("img-mirror-row").hidden = !st.installed;
  const busy = st.download && !st.download.finished;
  for (const m of st.models) {
    const row = document.createElement("label");
    row.className = "tts-voice img-model" + (m.id === st.model ? " is-selected" : "");
    row.dataset.model = m.id;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "img-model";
    radio.checked = m.id === st.model;
    radio.disabled = !m.downloaded;
    radio.addEventListener("change", async () => {
      await api.updateSettings({ image_model: m.id }).catch((e) => alert(e.message));
      refreshImagesPage();
    });
    const title = document.createElement("span");
    title.className = "tv-title";
    title.textContent = `${m.title}${m.recommended ? " · рекомендую" : ""} — ${m.note}`;
    row.append(radio, title);
    if (m.downloaded) {
      const state = document.createElement("span");
      state.className = "tv-state";
      state.textContent = "скачана ✓";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link-btn small danger";
      del.textContent = "удалить";
      del.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!confirm(`Удалить модель «${m.title}» (${m.size_gb} ГБ)?`)) return;
        await api.imagesDeleteModel(m.id).catch((err) => alert(err.message));
        refreshImagesPage();
      });
      row.append(state, del);
    } else {
      const get = document.createElement("button");
      get.type = "button";
      get.className = "btn btn-small tv-download";
      get.textContent = `Скачать · ${String(m.size_gb).replace(".", ",")} ГБ`;
      get.disabled = busy;
      get.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          await api.imagesDownload(m.id, $("img-mirror").value);
        } catch (err) {
          alert(err.message);
        }
        refreshImagesPage();
      });
      row.append(get);
    }
    box.append(row);
  }

  const d = st.download;
  $("img-dl").hidden = !d || (d.finished && !d.error);
  if (d) {
    const pct = d.total ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0;
    $("img-dl-fill").style.width = `${pct}%`;
    $("img-dl-text").textContent = d.error || `Скачиваю «${d.model}»: ${pct}% (${(d.done / 1073741824).toFixed(2)} из ${(d.total / 1073741824).toFixed(1)} ГБ)`;
    $("img-dl").classList.toggle("is-error", Boolean(d.error));
  }

  const ready = st.installed && st.models.some((m) => m.id === st.model && m.downloaded);
  $("img-form").classList.toggle("is-disabled", !ready);
  $("img-go").disabled = !ready || st.busy;
  $("img-prompt").placeholder = ready ? "Что нарисовать? Например: рыжий кот на подоконнике на закате, акварель"
    : "Сначала установите движок и скачайте модель — выше";

  // Пока что-то ставится или скачивается — обновляем раз в секунду
  clearTimeout(pollTimer);
  if ((installing || busy) && !$("images-view").hidden) pollTimer = setTimeout(refreshImagesPage, 1000);
}

async function renderGallery() {
  const grid = $("img-gallery");
  let items = [];
  try {
    items = (await api.imagesGallery()).items;
  } catch {
    /* галерея не загрузилась — покажем пустую */
  }
  grid.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "lessons-empty";
    empty.textContent = "Здесь появятся все нарисованные картинки — и со страницы, и из чатов.";
    grid.append(empty);
    return;
  }
  const handlers = {
    onDelete: () => renderGallery(),
    onMore: (file) => {
      $("img-prompt").value = file.meta?.request || file.meta?.prompt || "";
      $("img-orientation").value = file.meta?.orientation || "square";
      $("img-form").requestSubmit();
    },
  };
  for (const file of items) grid.append(thumb(file, (f) => openLightbox(f, handlers)));
}

export async function refreshImagesPage() {
  try {
    status = await api.imagesStatus();
  } catch (e) {
    $("img-install-text").textContent = `Не удалось получить статус: ${e.message}`;
    return;
  }
  renderSetup();
  renderGallery();
}

export function initImagesPage() {
  initLightbox();
  $("img-install-btn").addEventListener("click", async () => {
    await api.imagesInstall().catch((e) => alert(e.message));
    refreshImagesPage();
  });
  $("img-cancel").addEventListener("click", () => api.imagesCancel().catch(() => {}));
  $("img-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = $("img-prompt").value.trim();
    if (!prompt) return;
    $("img-error").hidden = true;
    $("img-go").disabled = true;
    $("img-run").hidden = false;
    $("img-run-text").textContent = "Готовлю промпт…";
    $("img-run-fill").style.width = "0";
    try {
      await generateWithProgress({
        prompt, orientation: $("img-orientation").value, count: Number($("img-count").value),
      }, (p) => {
        $("img-run-text").textContent = p.text || "";
        $("img-run-fill").style.width = `${p.total ? Math.round((p.step / p.total) * 100) : 5}%`;
      });
    } catch (err) {
      $("img-error").textContent = err.message;
      $("img-error").hidden = false;
    } finally {
      $("img-run").hidden = true;
      $("img-go").disabled = false;
      renderGallery();
    }
  });
}

export { ORIENT };
