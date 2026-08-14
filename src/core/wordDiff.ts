export type DiffOp = { type: "equal" | "add" | "del"; text: string };

/** 以空白为边界的词级 diff（LCS + 相邻同类合并）。 */
export function wordDiff(before: string, after: string): DiffOp[] {
  const tokens = (s: string): string[] => s.split(/(\s+)/).filter((t) => t.length > 0);
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push(ops, "equal", a[i]);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      push(ops, "add", b[j]);
      j++;
    } else {
      push(ops, "del", a[i]);
      i++;
    }
  }
  return ops;
}

function push(ops: DiffOp[], type: DiffOp["type"], text: string): void {
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}
