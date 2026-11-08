// =====================================================================
// Окно настроек, вкладка «Инструменты»: какие инструменты включены,
// папка для чтения файлов, поисковик, песочница Python.
// =====================================================================

import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

// id чекбокса → ключ настройки
const TOGGLES = {
  "t-enabled": "tools_enabled",
  "t-calculator": "tool_calculator",
  "t-web": "tool_web",
  "t-files": "tool_files",
  "t-python": "tool_python",
  "t-documents": "tool_documents",
  "t-artifacts": "artifacts_enabled",
  "t-confirm-web": "confirm_web",
  "t-confirm-python": "confirm_python",
};

let closeDialog = () => {};

export function initToolsTab({ onClose }) {
  closeDialog = onClose;
  $("t-enabled").addEventListener("change", updateDisabledState);
  $("t-provider").addEventListener("change", updateProviderField);
  $("t-root-check").addEventListener("click", checkFolder);
  $("tools-cancel").addEventListener("click", () => closeDialog());
  $("tools-form").addEventListener("submit", save);
}

/** Вызывается при открытии вкладки: заполняем форму текущими настройками. */
export async function showToolsTab() {
  const { values } = await api.getSettings();
  for (const [id, key] of Object.entries(TOGGLES)) $(id).checked = values[key];
  $("t-provider").value = values.web_provider;
  $("t-searxng").value = values.searxng_url;
  $("t-root").value = values.files_root;
  $("t-timeout").value = values.python_timeout;
  $("t-root-status").textContent = values.files_root ? "" : "Папка не выбрана — инструмент чтения файлов недоступен.";
  $("t-root-status").className = "hint";
  $("tools-error").hidden = true;
  updateDisabledState();
  updateProviderField();
}

function updateDisabledState() {
  $("tools-form").classList.toggle("tools-disabled", !$("t-enabled").checked);
}

function updateProviderField() {
  $("t-searxng-field").hidden = $("t-provider").value !== "searxng";
}

async function checkFolder() {
  const path = $("t-root").value.trim();
  const status = $("t-root-status");
  if (!path) {
    status.textContent = "Укажите путь к папке.";
    status.className = "hint bad";
    return;
  }
  try {
    const r = await api.checkFolder(path);
    status.textContent = `Папка найдена: ${r.files}${r.truncated ? "+" : ""} файлов.`;
    status.className = "hint ok";
  } catch (e) {
    status.textContent = e.message;
    status.className = "hint bad";
  }
}

async function save(e) {
  e.preventDefault();
  const changes = {
    web_provider: $("t-provider").value,
    searxng_url: $("t-searxng").value.trim(),
    files_root: $("t-root").value.trim(),
    python_timeout: Number($("t-timeout").value) || 10,
  };
  for (const [id, key] of Object.entries(TOGGLES)) changes[key] = $(id).checked;
  try {
    await api.updateSettings(changes);
  } catch (err) {
    $("tools-error").textContent = err.message;
    $("tools-error").hidden = false;
    return;
  }
  closeDialog();
}
