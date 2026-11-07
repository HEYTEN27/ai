// =====================================================================
// Окно настроек, вкладка «Персоны»: список слева, редактор справа.
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

// Ползунки параметров генерации: подписи и пояснения простыми словами
const SLIDERS = [
  {
    key: "temperature", label: "Температура", min: 0, max: 2, step: 0.05,
    hint: "«Смелость» ответов. 0.2–0.4 — точно и предсказуемо (код, факты), 0.7 — живо, выше 1 — фантазирует.",
  },
  {
    key: "top_p", label: "Top-p", min: 0.05, max: 1, step: 0.05,
    hint: "Из какой доли самых вероятных слов выбирать. Меньше — осторожнее и однообразнее.",
  },
  {
    key: "top_k", label: "Top-k", min: 1, max: 100, step: 1,
    hint: "Из скольких самых вероятных слов выбирать на каждом шаге. Для Qwen3 рекомендуют 20.",
  },
  {
    key: "repeat_penalty", label: "Штраф за повторы", min: 0.8, max: 1.5, step: 0.01,
    hint: "1.0 — без штрафа (рекомендуется для Qwen3). 1.1 — меньше повторов, если модель «зацикливается».",
  },
  {
    key: "num_predict", label: "Макс. длина ответа", min: 0, max: 4096, step: 64,
    hint: "В токенах (≈ 0,75 слова). 0 — без ограничения. Лимит обрывает ответ на полуслове.",
    format: (v) => (Number(v) === 0 ? "без лимита" : `${v} ток.`),
  },
];

let personas = [];
let selectedId = null; // id выбранной персоны, "new" — создаём новую
let onChangedCallback = () => {};

export function initPersonasTab({ onChanged }) {
  onChangedCallback = onChanged;
  buildSliders();
  $("persona-form").addEventListener("submit", savePersona);
  $("p-reset").addEventListener("click", resetPersona);
  $("p-delete").addEventListener("click", deletePersona);
}

/** Вызывается при открытии вкладки: загружаем свежий список. */
export async function showPersonasTab() {
  await reload();
  if (!personas.some((p) => p.id === selectedId)) selectedId = personas[0]?.id ?? null;
  renderList();
  fillForm(currentPersona());
}

async function reload() {
  personas = await api.listPersonas();
}

function currentPersona() {
  if (selectedId === "new") {
    return { id: "new", name: "", icon: "🙂", description: "", prompt: "", builtin: false,
      temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.0, num_predict: 0 };
  }
  return personas.find((p) => p.id === selectedId) || null;
}

function buildSliders() {
  const box = $("persona-sliders");
  for (const s of SLIDERS) {
    const wrap = document.createElement("div");
    wrap.className = "field slider";
    wrap.innerHTML = `
      <div class="field-row">
        <label for="p-${s.key}">${s.label}</label>
        <output id="p-${s.key}-value"></output>
      </div>
      <input type="range" id="p-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">
      <p class="hint">${s.hint}</p>`;
    box.append(wrap);
    const input = wrap.querySelector("input");
    input.addEventListener("input", () => updateSliderLabel(s));
  }
}

function updateSliderLabel(s) {
  const value = Number($(`p-${s.key}`).value);
  // Столько знаков после запятой, сколько у шага ползунка: 0.05 → «0.70», 0.01 → «1.00»
  const decimals = (String(s.step).split(".")[1] || "").length;
  $(`p-${s.key}-value`).textContent = s.format ? s.format(value) : value.toFixed(decimals);
}

function renderList() {
  const list = $("persona-list");
  list.innerHTML = "";
  for (const p of personas) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "persona-item" + (p.id === selectedId ? " active" : "");
    item.innerHTML = '<span class="p-icon"></span><span class="p-name"></span>';
    item.querySelector(".p-icon").textContent = p.icon; // textContent — защита от HTML в названии
    item.querySelector(".p-name").textContent = p.name;
    item.title = (p.description || p.name) + (p.builtin ? " (встроенная)" : "");
    item.addEventListener("click", () => select(p.id));
    list.append(item);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "persona-item persona-add" + (selectedId === "new" ? " active" : "");
  add.innerHTML = '<span class="p-icon">＋</span><span class="p-name">Новая персона</span>';
  add.addEventListener("click", () => select("new"));
  list.append(add);
}

function select(id) {
  selectedId = id;
  renderList();
  fillForm(currentPersona());
  if (id === "new") $("p-name").focus();
}

function fillForm(p) {
  $("persona-error").hidden = true;
  const form = $("persona-form");
  form.hidden = !p;
  if (!p) return;
  $("p-icon").value = p.icon;
  $("p-name").value = p.name;
  $("p-description").value = p.description;
  $("p-prompt").value = p.prompt;
  for (const s of SLIDERS) {
    $(`p-${s.key}`).value = p[s.key];
    updateSliderLabel(s);
  }
  // Встроенную можно сбросить, свою — удалить
  $("p-reset").hidden = !p.builtin;
  $("p-delete").hidden = p.builtin || p.id === "new";
}

function formData() {
  const data = {
    icon: $("p-icon").value.trim() || "🙂",
    name: $("p-name").value.trim(),
    description: $("p-description").value.trim(),
    prompt: $("p-prompt").value,
  };
  for (const s of SLIDERS) data[s.key] = Number($(`p-${s.key}`).value);
  return data;
}

async function savePersona(e) {
  e.preventDefault();
  const data = formData();
  if (!data.name) {
    showError("Укажите название персоны");
    return;
  }
  try {
    const saved = selectedId === "new" ? await api.createPersona(data) : await api.updatePersona(selectedId, data);
    selectedId = saved.id;
  } catch (err) {
    showError(err.message);
    return;
  }
  await afterChange();
}

async function resetPersona() {
  if (!confirm("Вернуть встроенную персону к исходным инструкции и параметрам?")) return;
  try {
    await api.resetPersona(selectedId);
  } catch (err) {
    showError(err.message);
    return;
  }
  await afterChange();
}

async function deletePersona() {
  const p = currentPersona();
  if (!p || !confirm(`Удалить персону «${p.name}»? Диалоги с ней перейдут на персону по умолчанию.`)) return;
  try {
    await api.deletePersona(p.id);
  } catch (err) {
    showError(err.message);
    return;
  }
  selectedId = null;
  await afterChange();
}

async function afterChange() {
  await showPersonasTab();
  onChangedCallback(); // обновить выпадающий список персон в чате
}

function showError(text) {
  const el = $("persona-error");
  el.textContent = text;
  el.hidden = false;
}
