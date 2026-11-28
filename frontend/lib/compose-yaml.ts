import yaml from "js-yaml";

/** Present compose text as normalized YAML for the stack editor (mirrors backend `compose_for_editor`). */
export function composeForEditor(compose: string): string {
  try {
    const value = yaml.load(compose);
    if (value === undefined) {
      return compose;
    }
    return yaml.dump(value, { lineWidth: -1, noRefs: true }).replace(/\n?$/, "\n");
  } catch {
    return compose;
  }
}

export function composeYamlSyntaxError(value: string): string {
  if (!value.trim()) return "";
  try {
    yaml.load(value);
    return "";
  } catch {
    return "The Compose file is not valid YAML.";
  }
}

const INDENT = "  ";

function leadingIndent(line: string): number {
  if (line.startsWith(INDENT)) return INDENT.length;
  if (line.startsWith("\t") || line.startsWith(" ")) return 1;
  return 0;
}

/** Tab inserts two spaces. Shift+Tab removes one indent. Selection covers whole lines. */
export function applyComposeTab(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  shift: boolean,
): { value: string; selectionStart: number; selectionEnd: number } {
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);

  if (!shift && from === to) {
    const next = value.slice(0, from) + INDENT + value.slice(to);
    const caret = from + INDENT.length;
    return { value: next, selectionStart: caret, selectionEnd: caret };
  }

  if (shift && from === to) {
    const start = value.lastIndexOf("\n", from - 1) + 1;
    const newline = value.indexOf("\n", from);
    const end = newline === -1 ? value.length : newline;
    const line = value.slice(start, end);
    const removed = leadingIndent(line);
    if (!removed) return { value, selectionStart: from, selectionEnd: from };
    const next = value.slice(0, start) + line.slice(removed) + value.slice(end);
    const caret = Math.max(start, from - removed);
    return { value: next, selectionStart: caret, selectionEnd: caret };
  }

  const start = value.lastIndexOf("\n", from - 1) + 1;
  const cursor = to > from && value[to - 1] === "\n" ? to - 1 : to;
  const newline = value.indexOf("\n", cursor);
  const end = newline === -1 ? value.length : newline;
  const lines = value.slice(start, end).split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const nextLines = lines.map((line, index) => {
    if (!shift) {
      if (index === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    }
    const removed = leadingIndent(line);
    if (index === 0) firstDelta = -removed;
    totalDelta -= removed;
    return line.slice(removed);
  });
  const nextValue = value.slice(0, start) + nextLines.join("\n") + value.slice(end);
  const nextStart = Math.max(0, Math.min(nextValue.length, from + firstDelta));
  const nextEnd = Math.max(nextStart, Math.min(nextValue.length, to + totalDelta));
  return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
}