/** Semver-ish `a >= b` on major.minor.patch. Non-numeric versions (e.g. "dev") always pass. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return true;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  }
  return true;
}

function parse(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
