// =====================================================================
// Превращение markdown-ответа модели в HTML.
//   marked     — парсер markdown (глобальная переменная из vendor/marked.min.js)
//   DOMPurify  — вычищает опасный HTML (модель может «написать» <script>)
//   hljs       — подсветка синтаксиса кода (highlight.js)
// =====================================================================

/* global marked, DOMPurify, hljs */

marked.setOptions({
  gfm: true, // GitHub-markdown: таблицы, ~~зачёркивание~~, списки задач
  breaks: true, // одиночный перенос строки = <br>, модели часто так пишут
});

/** Markdown → безопасный HTML. */
export function renderMarkdown(text) {
  const html = marked.parse(text || "");
  return DOMPurify.sanitize(html);
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

/**
 * Оформляет блоки кода внутри элемента: шапка с названием языка,
 * кнопка «Копировать» и (если highlight = true) подсветка синтаксиса.
 *
 * Во время стриминга подсветку не делаем (дорого делать её 30 раз в секунду),
 * а включаем один раз, когда ответ готов.
 */
export function enhanceCodeBlocks(container, { highlight = true } = {}) {
  container.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains("code-block")) return; // уже оформлен

    const langClass = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = langClass ? langClass.slice("language-".length) : "";

    if (highlight) {
      // Подсвечиваем, только если язык известен highlight.js, иначе пусть угадает сам
      if (!lang || hljs.getLanguage(lang)) hljs.highlightElement(code);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const header = document.createElement("div");
    header.className = "code-header";
    const label = document.createElement("span");
    label.textContent = lang || "код";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.innerHTML = `${COPY_ICON}<span>Копировать</span>`;
    copyBtn.addEventListener("click", () => copyText(code.innerText, copyBtn.querySelector("span")));
    header.append(label, copyBtn);

    pre.replaceWith(wrapper);
    wrapper.append(header, pre);
  });
}

/** Копирует текст в буфер обмена и на секунду меняет подпись кнопки. */
export async function copyText(text, labelEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Запасной способ для старых браузеров и небезопасного контекста
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (labelEl) {
    const old = labelEl.textContent;
    labelEl.textContent = "Скопировано";
    setTimeout(() => (labelEl.textContent = old), 1200);
  }
}
