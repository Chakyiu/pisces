export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string };

/**
 * A small line diff for compose bodies. Proposals are confirmed by a human, so
 * the diff has to show what the agent asked for, not just the new file. Falls
 * back to "everything is new" when the two sides are too large to line up.
 */
export function unifiedDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;

  if (n * m > 250_000) {
    return [{ kind: "hunk", text: `@@ -0,0 +1,${m} @@` }, ...b.map((text) => ({ kind: "add" as const, text: `+${text}` }))];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { kind: "add" | "del" | "ctx"; text: string; aLine: number; bLine: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i], aLine: i, bLine: j });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", text: a[i], aLine: i, bLine: j });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j], aLine: i, bLine: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i], aLine: i, bLine: j });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j], aLine: i, bLine: j });
    j += 1;
  }

  // Keep only the changes plus `context` unchanged lines around them.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === "ctx") return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) {
      keep[k] = true;
    }
  });

  const out: DiffLine[] = [];
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < ops.length && keep[index]) index += 1;
    const block = ops.slice(start, index);
    const aStart = block[0].aLine + 1;
    const bStart = block[0].bLine + 1;
    const aCount = block.filter((op) => op.kind !== "add").length;
    const bCount = block.filter((op) => op.kind !== "del").length;
    out.push({ kind: "hunk", text: `@@ -${aStart},${aCount} +${bStart},${bCount} @@` });
    for (const op of block) {
      const prefix = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
      out.push({ kind: op.kind, text: `${prefix}${op.text}` });
    }
  }
  return out;
}
