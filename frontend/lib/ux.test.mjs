import assert from "node:assert/strict";
import test from "node:test";
import { changedEnvKeys, dockerSectionHref, listedNames, safeNextPath } from "./ux.ts";

test("safeNextPath keeps relative console paths", () => {
  assert.equal(safeNextPath("/e/abc/containers?tab=logs#container-logs"), "/e/abc/containers?tab=logs#container-logs");
  assert.equal(safeNextPath("/home"), "/home");
  assert.equal(safeNextPath("  /stacks  "), "/stacks");
});

test("safeNextPath rejects off-site and login loops", () => {
  assert.equal(safeNextPath("https://evil.example/phish"), null);
  assert.equal(safeNextPath("//evil.example"), null);
  assert.equal(safeNextPath("/\\evil.example"), null);
  assert.equal(safeNextPath("/%2f%2fevil.example"), null);
  assert.equal(safeNextPath("/login"), null);
  assert.equal(safeNextPath("/login?next=/home"), null);
  assert.equal(safeNextPath(""), null);
  assert.equal(safeNextPath(null), null);
});

test("dockerSectionHref keeps the section and drops the resource id", () => {
  assert.equal(dockerSectionHref("/e/a/containers/abc", "a", "b", "docker", "docker"), "/e/b/containers");
  assert.equal(dockerSectionHref("/e/a/stacks/new", "a", "b", "docker", "docker"), "/e/b/stacks");
  assert.equal(dockerSectionHref("/e/a", "a", "b", "docker", "docker"), "/e/b");
  assert.equal(dockerSectionHref("/e/a/workloads", "a", "b", "docker", "kubernetes"), "/e/b");
  assert.equal(dockerSectionHref("/e/a/containers", "a", "k", "kubernetes", "docker"), "/e/k");
});

test("listedNames stops after five names", () => {
  assert.equal(listedNames(["a", "b"]), "a, b");
  assert.equal(listedNames(["a", "b", "c", "d", "e", "f", "g"]), "a, b, c, d, e and 2 more");
});

test("changedEnvKeys returns keys only", () => {
  const before = [{ key: "TOKEN", value: "secret-old" }, { key: "PLAIN", value: "same" }];
  const after = [{ key: "TOKEN", value: "secret-new" }, { key: "PLAIN", value: "same" }, { key: "ADDED", value: "hidden" }];
  const keys = changedEnvKeys(before, after);
  assert.deepEqual(keys, ["ADDED", "TOKEN"]);
  assert.equal(JSON.stringify(keys).includes("secret"), false);
});
