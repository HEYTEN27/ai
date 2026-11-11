// =====================================================================
// Вложения в поле ввода: скрепка, перетаскивание файлов, вставка из буфера.
// Файл загружается на сервер сразу (там же извлекается текст), в поле
// появляется «чип» с именем и размером. При отправке сообщения уходят id файлов.
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
export const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.html,.css,.js,.ts,.tsx,.jsx," +
  ".py,.java,.kt,.c,.h,.cpp,.cs,.go,.rs,.php,.rb,.swift,.sql,.sh,.bat,.ps1,.vue,.ini,.toml," +
  ".png,.jpg,.jpeg,.webp,.gif,.bmp," + // картинки (этап 14) — их смотрит модель зрения
  ".stl,.obj,.glb"; // 3D-модели (этап 15б)

/** @type {{key:number, file:File, status:'uploading'|'ready'|'error', record?:object, error?:string, promise:Promise}[]} */
let items = [];
let counter = 0;
let onChange = () => {};

/** Иконка по расширению файла. */
export function fileIcon(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return { pdf: "📕", docx: "📝", doc: "📝", pptx: "📊", xlsx: "📗", csv: "📗", tsv: "📗", png: "🖼️", jpg: "🖼️",
    jpeg: "🖼️", webp: "🖼️", gif: "🖼️", bmp: "🖼️", stl: "🧊", obj: "🧊", glb: "🧊" }[ext] || "📄";
}

/** Картинка или скан PDF — у таких вложений есть миниатюра. */
export function hasPreview(record) {
  return ["image", "scan"].includes(record?.meta?.type);
}

export function previewUrl(record) {
  return `/api/files/${record.id}/preview`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n.toLocaleString("ru-RU")} ${word}`;
}

/** Краткое описание содержимого: «12 стр.», «3 листа», «8 слайдов», «4 200 символов». */
export function describeFile(record) {
  const m = record.meta || {};
  const parts = [formatSize(record.size)];
  if (m.type === "model3d") {
    const f = (x) => (Math.round(x * 10) / 10).toLocaleString("ru-RU");
    parts.push(`${m.size_mm.map(f).join(" × ")} мм`, `${m.triangles.toLocaleString("ru-RU")} треуг.`);
  } else if (m.type === "image") parts.push(`${m.width}×${m.height}`);
  else if (m.type === "scan") parts.push(`скан · ${m.pages} стр.`);
  else if (m.pages) parts.push(`${m.pages} стр.`);
  else if (m.slides) parts.push(plural(m.slides, "слайд", "слайда", "слайдов"));
  else if (m.sheets?.length) parts.push(plural(m.sheets.length, "лист", "листа", "листов"));
  else if (m.chars) parts.push(plural(m.chars, "символ", "символа", "символов"));
  if (m.truncated) parts.push("обрезан");
  return parts.join(" · ");
}

function render() {
  const list = $("attach-list");
  list.innerHTML = "";
  list.hidden = !items.length;
  for (const item of items) {
    const chip = document.createElement("div");
    chip.className = `attach-chip is-${item.status}`;
    chip.dataset.name = item.file.name;
    const icon = document.createElement("span");
    icon.className = "a-icon";
    icon.textContent = item.status === "uploading" ? "" : item.status === "error" ? "⚠️" : fileIcon(item.file.name);
    if (item.status === "ready" && hasPreview(item.record)) {
      // Миниатюра вместо значка: сразу видно, тот ли скриншот прикрепили
      icon.textContent = "";
      icon.classList.add("has-thumb");
      const img = document.createElement("img");
      img.src = previewUrl(item.record);
      img.alt = "";
      icon.append(img);
    }
    const text = document.createElement("span");
    text.className = "a-text";
    const name = document.createElement("span");
    name.className = "a-name";
    name.textContent = item.file.name;
    const info = document.createElement("span");
    info.className = "a-info";
    info.textContent = item.status === "uploading" ? "читаю файл…"
      : item.status === "error" ? item.error : describeFile(item.record);
    text.append(name, info);
    chip.title = item.status === "error" ? item.error : item.file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "a-remove";
    remove.title = "Убрать";
    remove.setAttribute("aria-label", `Убрать ${item.file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeItem(item.key));
    chip.append(icon, text, remove);
    list.append(chip);
  }
  onChange();
}

function removeItem(key) {
  const item = items.find((i) => i.key === key);
  items = items.filter((i) => i.key !== key);
  // Уже загруженный, но не отправленный файл удаляем и на сервере
  if (item?.record) api.deleteFile(item.record.id).catch(() => {});
  render();
}

/** Добавить файлы (из кнопки, перетаскивания или буфера обмена). */
export function addFiles(fileList) {
  for (const file of fileList) {
    if (items.length >= MAX_FILES) {
      alert(`Можно прикрепить не больше ${MAX_FILES} файлов к одному сообщению.`);
      break;
    }
    const item = { key: ++counter, file, status: "uploading" };
    if (file.size > MAX_BYTES) {
      Object.assign(item, { status: "error", error: "больше 25 МБ" });
      item.promise = Promise.resolve();
    } else {
      item.promise = api.uploadAttachment(file)
        .then((record) => Object.assign(item, { status: "ready", record }))
        .catch((e) => Object.assign(item, { status: "error", error: e.message }))
        .finally(render);
    }
    items.push(item);
  }
  render();
}

/** Есть ли что отправлять (готовые файлы или ещё загружающиеся). */
export function hasAttachments() {
  return items.some((i) => i.status !== "error");
}

/** Дождаться загрузки и вернуть готовые записи. Файлы с ошибкой не отправляются. */
export async function takeReady() {
  await Promise.all(items.map((i) => i.promise));
  const ready = items.filter((i) => i.status === "ready").map((i) => i.record);
  items = items.filter((i) => i.status === "error"); // ошибки остаются на виду, пока их не уберут
  render();
  return ready;
}

export function initAttachments({ onChange: changed }) {
  onChange = changed;
  const picker = $("attach-input");
  picker.accept = ACCEPT;
  $("attach-btn").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    addFiles(picker.files);
    picker.value = ""; // чтобы тот же файл можно было выбрать ещё раз
  });

  // Вставка файла из буфера обмена (Ctrl+V скопированного в проводнике файла)
  $("input").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  // Перетаскивание файлов в окно чата
  const zone = document.querySelector(".main");
  const overlay = $("drop-overlay");
  let depth = 0; // dragenter/dragleave срабатывают и на дочерних элементах — считаем вложенность
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  zone.addEventListener("dragenter", (e) => {
    // На страницах «Память», «База знаний» и т.п. — не перехватываем (у базы знаний своя зона загрузки)
    if (!hasFiles(e) || zone.matches(".show-memory, .show-knowledge, .show-dataset, .show-training")) return;
    depth++;
    overlay.hidden = false;
  });
  zone.addEventListener("dragover", (e) => {
    if (hasFiles(e) && !overlay.hidden) e.preventDefault(); // без этого браузер откроет файл вместо «бросить сюда»
  });
  zone.addEventListener("dragleave", () => {
    if (--depth <= 0) {
      depth = 0;
      overlay.hidden = true;
    }
  });
  zone.addEventListener("drop", (e) => {
    if (overlay.hidden) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    addFiles(e.dataTransfer.files);
    $("input").focus();
  });
}
