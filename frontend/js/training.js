// =====================================================================
// Страница «Обучение»: готовность датасета, пакет для Colab,
// подключение обученной модели к Ollama (с прогрессом).
// =====================================================================

import { api, streamSSE } from "./api.js";

const $ = (id) => document.getElementById(id);
let onModelAdded = () => {};
let busy = false;

const STAGES = { hash: "Проверяю файл (контрольная сумма)…", upload: "Копирую файл в Ollama…", create: "Создаю модель…" };

export function initTrainingPage({ onModelAdded: callback }) {
  onModelAdded = callback || (() => {});
  $("tr-import-form").addEventListener("submit", importModel);
  // Сжатие до Q4_K_M имеет смысл только для полной модели, не для адаптера
  document.querySelectorAll('input[name="tr-kind"]').forEach((r) => r.addEventListener("change", () => {
    $("tr-quantize").disabled = r.value === "adapter" && r.checked;
  }));
}

export async function refreshTrainingPage() {
  let s;
  try {
    s = await api.trainingStatus();
  } catch (e) {
    $("tr-checks").textContent = `Не удалось получить состояние: ${e.message}`;
    return;
  }
  const list = $("tr-checks");
  list.innerHTML = "";
  for (const check of s.checks) {
    const li = document.createElement("li");
    li.className = check.level;
    li.textContent = check.text;
    list.append(li);
  }
  $("tr-config").textContent = s.ready
    ? `Рекомендуемые настройки (подставятся в Colab сами): эпох — ${s.config.epochs}, шагов обучения — ${s.steps}, ` +
      `всего в Colab ≈ ${s.estimated_minutes} мин вместе с установкой и экспортом.`
    : "";
  const pkg = $("tr-package");
  pkg.classList.toggle("disabled", !s.ready);
  pkg.setAttribute("aria-disabled", String(!s.ready));
  pkg.onclick = s.ready ? null : (e) => e.preventDefault();
  $("tr-base-note").textContent = s.base_installed ? "" : "Нужна исходная модель: ollama pull qwen3:8b";
  $("tr-models").textContent = s.models.length ? `Уже подключены: ${s.models.join(", ")}` : "";
}

function setStage(text, cls = "") {
  $("tr-stage").textContent = text;
  $("tr-stage").className = `tr-stage ${cls}`;
}

function log(text) {
  if (!text) return;
  const line = document.createElement("div");
  line.textContent = text;
  $("tr-log").append(line);
  $("tr-log").scrollTop = $("tr-log").scrollHeight;
}

async function importModel(e) {
  e.preventDefault();
  if (busy) return;
  const body = {
    path: $("tr-path").value.trim(),
    name: $("tr-name").value.trim(),
    kind: document.querySelector('input[name="tr-kind"]:checked').value,
    quantize: $("tr-quantize").checked && !$("tr-quantize").disabled,
  };
  busy = true;
  $("tr-import-btn").disabled = true;
  $("tr-progress").hidden = false;
  $("tr-log").innerHTML = "";
  $("tr-bar").style.width = "0%";
  setStage("Начинаю…");
  try {
    await streamSSE("/api/training/import", body, (event, data) => {
      if (event === "error") {
        setStage(data.message, "error");
        return;
      }
      if (data.stage === "done") {
        setStage(`✓ ${data.message}`, "ok");
        $("tr-bar").style.width = "100%";
        onModelAdded(data.model);
        refreshTrainingPage();
        return;
      }
      setStage(STAGES[data.stage] || data.stage);
      if (typeof data.progress === "number") $("tr-bar").style.width = `${Math.round(data.progress * 100)}%`;
      log(data.message);
    });
  } catch (err) {
    setStage(err.message, "error"); // ошибки ввода (нет файла, плохое имя) приходят обычным ответом 422
  } finally {
    busy = false;
    $("tr-import-btn").disabled = false;
  }
}
