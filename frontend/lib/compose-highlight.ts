/** Line-based YAML highlighting for the compose editor. VS Code scopes, simplified:
 * keys, quoted strings, numbers, boolean/null keywords and comments are colored;
 * everything else (indent, dashes, colons, plain scalars) keeps the default text color. */

export type HighlightTokenType = "plain" | "key" | "string" | "number" | "keyword" | "comment";

export interface HighlightToken {
  text: string;
  type: HighlightTokenType;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const KEYWORD = /^(true|false|null|yes|no|on|off|~)$/;
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_./-]*|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*")(\s*):(?=\s|$)/;
const VALUE_PART = /'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|\s+|[^\s'"]+/g;

function push(tokens: HighlightToken[], text: string, type: HighlightTokenType) {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) last.text += text;
  else tokens.push({ text, type });
}

/** Index where a `#` comment starts, or -1. `#` opens a comment at line start or after
 * whitespace, outside single/double quotes. */
export function commentStart(line: string): number {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (single) {
      if (char === "'") {
        if (line[index + 1] === "'") index++;
        else single = false;
      }
      continue;
    }
    if (double) {
      if (char === "\\") index++;
      else if (char === '"') double = false;
      continue;
    }
    if (char === "'") single = true;
    else if (char === '"') double = true;
    else if (char === "#" && (index === 0 || line[index - 1] === " " || line[index - 1] === "\t")) return index;
  }
  return -1;
}

function scanValue(text: string, tokens: HighlightToken[]) {
  VALUE_PART.lastIndex = 0;
  let match;
  while ((match = VALUE_PART.exec(text))) {
    const word = match[0];
    if (/^\s+$/.test(word)) push(tokens, word, "plain");
    else if (word.startsWith("'") || word.startsWith('"')) push(tokens, word, "string");
    else if (NUMBER.test(word)) push(tokens, word, "number");
    else if (KEYWORD.test(word)) push(tokens, word, "keyword");
    else push(tokens, word, "plain");
  }
}

export function highlightYamlLine(line: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const cut = commentStart(line);
  const body = cut === -1 ? line : line.slice(0, cut);
  const comment = cut === -1 ? "" : line.slice(cut);

  const prefix = body.match(/^\s*(?:-\s+)*/)?.[0] ?? "";
  const rest = body.slice(prefix.length);
  const key = rest.match(KEY);
  if (key) {
    push(tokens, prefix, "plain");
    push(tokens, key[1], "key");
    push(tokens, `${key[2]}:`, "plain");
    scanValue(rest.slice(key[0].length), tokens);
  } else {
    scanValue(body, tokens);
  }
  push(tokens, comment, "comment");
  return tokens;
}

export function highlightCompose(value: string): HighlightToken[][] {
  return value.split("\n").map(highlightYamlLine);
}
