// `node --test lib/compose-yaml.test.mjs` from frontend/.
import assert from "node:assert/strict";
import test from "node:test";
import { applyComposeTab, composeYamlSyntaxError } from "./compose-yaml.ts";

test("tab inserts two spaces at the caret", () => {
  const next = applyComposeTab("ab\ncd", 1, 1, false);
  assert.equal(next.value, "a  b\ncd");
  assert.equal(next.selectionStart, 3);
  assert.equal(next.selectionEnd, 3);
});

test("tab indents every selected line", () => {
  const next = applyComposeTab("a\nb", 0, 3, false);
  assert.equal(next.value, "  a\n  b");
  assert.equal(next.selectionStart, 2);
  assert.equal(next.selectionEnd, 7);
});

test("shift-tab removes one indent on the current line", () => {
  const next = applyComposeTab("  image: nginx", 4, 4, true);
  assert.equal(next.value, "image: nginx");
  assert.equal(next.selectionStart, 2);
});

test("shift-tab of a line-start selection stays inside the text", () => {
  const next = applyComposeTab("  a\n  b", 0, 6, true);
  assert.equal(next.value, "a\nb");
  assert.equal(next.selectionStart, 0);
  assert.ok(next.selectionEnd <= next.value.length);
  assert.ok(next.selectionEnd >= next.selectionStart);
});

test("shift-tab on a line with no indent does not move focus or change text", () => {
  const next = applyComposeTab("image: nginx", 2, 2, true);
  assert.equal(next.value, "image: nginx");
  assert.equal(next.selectionStart, 2);
});

test("invalid compose yaml is reported and valid yaml is not", () => {
  assert.equal(composeYamlSyntaxError("services: ["), "The Compose file is not valid YAML.");
  assert.equal(composeYamlSyntaxError("services:\n  web:\n    image: nginx\n"), "");
  assert.equal(composeYamlSyntaxError("   "), "");
});
