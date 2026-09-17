/** Small statistics helpers. No dependency, all population (not sample) statistics. */

export function mean(a: number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}

export function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / a.length);
}

/** Linear-interpolated quantile on an array that is already sorted ascending. */
export function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(a: number[]): number {
  return quantileSorted([...a].sort((x, y) => x - y), 0.5);
}

/**
 * Normalised median absolute deviation: 1.4826 * MAD / median.
 *
 * This is the stick-slip dispersion index. Standard deviation was the obvious
 * choice and it is the wrong one here: the torque channel drops to an exact 0
 * on a large minority of samples while the string is demonstrably still turning
 * (see docs/DATA-NOTES.md). Those dropouts are outliers, and sd is dominated by
 * outliers while MAD is not. Even after filtering the exact zeros, a handful of
 * residual spikes remain, so the robust statistic is the honest one.
 */
export function normalisedMad(a: number[]): number | null {
  if (a.length < 4) return null;
  const med = median(a);
  if (med <= 0) return null;
  const dev = a.map((v) => Math.abs(v - med));
  return (1.4826 * median(dev)) / med;
}

/** Drop runs of consecutive identical values (held frames), keeping the first of each run. */
export function dropHeldFrames(a: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1]) out.push(a[i]);
  return out;
}
