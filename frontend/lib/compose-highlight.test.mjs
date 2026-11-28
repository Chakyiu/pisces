// `node --test lib/compose-highlight.test.mjs` from frontend/.
import assert from "node:assert/strict";
import test from "node:test";
import { commentStart, highlightCompose, highlightYamlLine } from "./compose-highlight.ts";

function types(line) {
  return highlightYamlLine(line).map((token) => [token.type, token.text]);
}

test("keys are colored, the colon and value stay plain", () => {
  assert.deepEqual(types("  image: nginx"), [
    ["plain", "  "],
    ["key", "image"],
    ["plain", ": nginx"],
  ]);
});

test("keys with dashes are one key token", () => {
  const tokens = types("libra-redis:");
  assert.deepEqual(tokens[0], ["key", "libra-redis"]);
});

test("quoted strings in values are colored", () => {
  assert.deepEqual(types("- '60'"), [
    ["plain", "- "],
    ["string", "'60'"],
  ]);
});

test("port mappings are not numbers", () => {
  assert.deepEqual(types("- 13000:3000"), [
    ["plain", "- 13000:3000"],
  ]);
});

test("bare numbers are colored", () => {
  assert.deepEqual(types("  PORT: 3000"), [
    ["plain", "  "],
    ["key", "PORT"],
    ["plain", ": "],
    ["number", "3000"],
  ]);
});

test("booleans and null are keywords", () => {
  assert.deepEqual(types("  restart: true"), [
    ["plain", "  "],
    ["key", "restart"],
    ["plain", ": "],
    ["keyword", "true"],
  ]);
  assert.deepEqual(types("x: null").at(-1), ["keyword", "null"]);
});

test("comments are colored and win over everything after them", () => {
  assert.deepEqual(types("image: nginx # latest"), [
    ["key", "image"],
    ["plain", ": nginx "],
    ["comment", "# latest"],
  ]);
});

test("a hash inside quotes is not a comment", () => {
  assert.equal(commentStart('x: "a#b"'), -1);
  assert.equal(commentStart("x: a#b"), -1);
  assert.equal(commentStart("x: a #b"), 5);
  assert.equal(commentStart("# full line"), 0);
});

test("urls keep one plain token", () => {
  assert.deepEqual(types("  REDIS_URL: redis://libra-redis:6379"), [
    ["plain", "  "],
    ["key", "REDIS_URL"],
    ["plain", ": redis://libra-redis:6379"],
  ]);
});

test("list item keys are colored", () => {
  assert.deepEqual(types("- image: nginx"), [
    ["plain", "- "],
    ["key", "image"],
    ["plain", ": nginx"],
  ]);
});

test("empty lines yield no tokens", () => {
  assert.deepEqual(highlightYamlLine(""), []);
});

test("highlightCompose keeps one token list per line, trailing newline included", () => {
  const lines = highlightCompose("a: 1\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].length, 0);
});
