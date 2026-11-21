/**
 * Detects user message submissions in the Codex Desktop composer via DOM events
 * (Enter key in the composer editor, send button click, or form submit), without
 * relying on internal codexhost custom events.
 */

export const COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

const SUBMIT_LABEL_PATTERN = /(^|\s)(send|submit|发送|提交)(\s|$)/u;

function eventElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") return null;
  if (typeof (target as Element).closest === "function") return target as Element;
  const parent = (target as Node).parentElement;
  return parent && typeof parent.closest === "function" ? parent : null;
}

function buttonDescription(button: HTMLButtonElement): string {
  const read = (name: string): string | null =>
    typeof button.getAttribute === "function" ? button.getAttribute(name) : null;
  return [button.type, read("aria-label"), read("title"), read("data-testid")]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

export function isComposerSubmitButton(button: HTMLButtonElement): boolean {
  if (button.type === "submit") return true;
  return SUBMIT_LABEL_PATTERN.test(buttonDescription(button));
}

function isDisabledButton(button: HTMLButtonElement): boolean {
  return Boolean(button.disabled) || button.getAttribute("aria-disabled") === "true";
}

function findSubmitButton(composer: Element): HTMLButtonElement | null {
  if (typeof composer.querySelectorAll !== "function") return null;
  for (const button of composer.querySelectorAll<HTMLButtonElement>("button")) {
    if (isComposerSubmitButton(button)) return button;
  }
  return null;
}

function editorHasText(editor: Element): boolean {
  const value = (editor as HTMLTextAreaElement).value;
  if (typeof value === "string") return value.trim().length > 0;
  return (editor.textContent ?? "").trim().length > 0;
}

function isEnterSubmissionKey(event: KeyboardEvent): boolean {
  if (event.isComposing || event.repeat) return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
}

/**
 * Attaches capture-phase listeners to `doc` and invokes `onSubmission` when the
 * user submits a message in the Desktop composer. Returns a cleanup function.
 */
export function observeComposerSubmission(doc: Document, onSubmission: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isEnterSubmissionKey(event)) return;
    const el = eventElement(event.target);
    if (!el) return;
    const editor = el.closest(EDITOR_SELECTOR);
    if (!editor) return;
    const composer = editor.closest(COMPOSER_SELECTOR);
    if (!composer) return;
    const sendButton = findSubmitButton(composer);
    if (sendButton) {
      if (isDisabledButton(sendButton)) return;
    } else if (!editorHasText(editor)) {
      return;
    }
    onSubmission();
  };

  const onClick = (event: MouseEvent): void => {
    const el = eventElement(event.target);
    const button = el?.closest<HTMLButtonElement>("button");
    if (!button) return;
    if (!button.closest(COMPOSER_SELECTOR)) return;
    if (!isComposerSubmitButton(button) || isDisabledButton(button)) return;
    onSubmission();
  };

  const onSubmit = (event: Event): void => {
    const el = eventElement(event.target);
    if (!el) return;
    if (el.closest(COMPOSER_SELECTOR) || el.querySelector?.(COMPOSER_SELECTOR)) {
      onSubmission();
    }
  };

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("submit", onSubmit, true);

  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("submit", onSubmit, true);
  };
}
