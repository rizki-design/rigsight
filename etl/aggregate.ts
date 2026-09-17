import type { MinuteRecord, OpState, DdrRow } from "../src/lib/types.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

export interface IntervalAggregate {
  from: number;
  to: number;
  /** Minutes we actually have data for - the denominator for every rate below. */
  measuredMinutes: number;
  missingMinutes: number;
  depthStart: number | null;
  depthEnd: number | null;
  footage: number;
  /** Minutes classified as making new hole (DRILLING or SLIDING). */
  onBottomMinutes: number;
  /**
   * Footage divided by on-bottom time. This is what a drilling engineer means by
   * average ROP for an interval.
   */
  ropOnBottom: number | null;
  /**
   * Footage divided by total measured time, including trips, connections and
   * repairs. Always lower, and it is the number that actually predicts when the
   * well finishes.
   */
  ropOverall: number | null;
  /**
   * The mean of the vendor ROP channel over the same window. Published only so the
   * gap against ropOnBottom is visible - see the note in computeIntervals.
   */
  ropChannelMean: number | null;
  stateMinutes: Partial<Record<OpState, number>>;
}

/**
 * ---------------------------------------------------------------------------
 * PROGRESS AND RATE AGGREGATION
 * ---------------------------------------------------------------------------
 * One decision here is worth more than the rest of the file.
 *
 * "Average ROP for this interval" looks like it should be the mean of the ROP
 * column. On this feed that is wrong, and wrong in a direction that flatters the
 * rig. The ROP channel never reads zero - it sits at 1-3 ft/hr through trips,
 * connections and repairs - so averaging it mixes real drilling rate with a floor
 * value from hours when no hole was being made at all.
 *
 * What is computed instead:
 *
 *   ropOnBottom = footage / hours actually spent making hole
 *       The drilling performance number. Answers "how fast does this bit cut?"
 *
 *   ropOverall  = footage / all measured hours in the interval
 *       The delivery number. Answers "when does this well finish?" and is the one
 *       that exposes time lost to trips and non-productive time.
 *
 * Both come from the change in hole depth, which is measured, rather than from
 * integrating a smoothed rate channel. `ropChannelMean` is carried alongside purely
 * so the discrepancy is visible rather than hidden - on this well the vendor
 * channel and the measured on-bottom rate disagree by a wide margin, and that
 * discrepancy is itself a finding.
 *
 * Feed gaps are excluded from every denominator. Counting the 144-minute blackout
 * on 10 Sep as drilling time would understate ROP for that interval by roughly a
 * third.
 */
export function computeIntervals(minutes: MinuteRecord[], intervalMs: number): IntervalAggregate[] {
  if (!minutes.length) return [];

  const out: IntervalAggregate[] = [];
  const start = Math.floor(minutes[0].t / intervalMs) * intervalMs;
  const end = minutes[minutes.length - 1].t;

  let i = 0;
  for (let b = start; b <= end; b += intervalMs) {
    const bucket: MinuteRecord[] = [];
    while (i < minutes.length && minutes[i].t < b + intervalMs) {
      if (minutes[i].t >= b) bucket.push(minutes[i]);
      i++;
    }
    // Step back one so a minute on the boundary is not dropped by the next bucket.
    if (i > 0 && minutes[i - 1].t >= b + intervalMs) i--;

    if (!bucket.length) {
      out.push({
        from: b,
        to: b + intervalMs,
        measuredMinutes: 0,
        missingMinutes: intervalMs / MINUTE,
        depthStart: null,
        depthEnd: null,
        footage: 0,
        onBottomMinutes: 0,
        ropOnBottom: null,
        ropOverall: null,
        ropChannelMean: null,
        stateMinutes: {},
      });
      continue;
    }

    const stateMinutes: Partial<Record<OpState, number>> = {};
    let footage = 0;
    let onBottom = 0;
    let ropSum = 0;
    let ropN = 0;

    for (const m of bucket) {
      stateMinutes[m.state] = (stateMinutes[m.state] ?? 0) + 1;
      footage += m.dHole;
      if (m.state === "DRILLING" || m.state === "SLIDING") onBottom++;
      const r = m.stats.ROP?.mean;
      if (r !== undefined) {
        ropSum += r;
        ropN++;
      }
    }

    const measured = bucket.length;
    const depths = bucket.map((m) => m.holeDepth).filter((d): d is number => d !== null);

    out.push({
      from: b,
      to: b + intervalMs,
      measuredMinutes: measured,
      missingMinutes: Math.max(0, intervalMs / MINUTE - measured),
      depthStart: depths.length ? depths[0] : null,
      depthEnd: depths.length ? depths[depths.length - 1] : null,
      footage: +footage.toFixed(1),
      onBottomMinutes: onBottom,
      ropOnBottom: onBottom > 0 ? +((footage / onBottom) * 60).toFixed(1) : null,
      ropOverall: measured > 0 ? +((footage / measured) * 60).toFixed(1) : null,
      ropChannelMean: ropN > 0 ? +(ropSum / ropN).toFixed(2) : null,
      stateMinutes,
    });
  }

  return out;
}

export interface WellSummary {
  from: number;
  to: number;
  measuredHours: number;
  missingHours: number;
  depthStart: number | null;
  depthEnd: number | null;
  totalFootage: number;
  onBottomHours: number;
  ropOnBottom: number | null;
  ropOverall: number | null;
  ropChannelMean: number | null;
  stateHours: Partial<Record<OpState, number>>;
  /** From the DDR, over the same window - the reported, human-logged view. */
  ddrNptHours: number;
  ddrTotalHours: number;
}

export function summarise(minutes: MinuteRecord[], ddr: DdrRow[]): WellSummary {
  const stateMinutes: Partial<Record<OpState, number>> = {};
  let footage = 0;
  let onBottom = 0;
  let ropSum = 0;
  let ropN = 0;

  for (const m of minutes) {
    stateMinutes[m.state] = (stateMinutes[m.state] ?? 0) + 1;
    footage += m.dHole;
    if (m.state === "DRILLING" || m.state === "SLIDING") onBottom++;
    const r = m.stats.ROP?.mean;
    if (r !== undefined) {
      ropSum += r;
      ropN++;
    }
  }

  const from = minutes[0].t;
  const to = minutes[minutes.length - 1].t + MINUTE;
  const wallMinutes = (to - from) / MINUTE;
  const depths = minutes.map((m) => m.holeDepth).filter((d): d is number => d !== null);

  // Only DDR lines overlapping the telemetry window, so the two views describe the
  // same five days.
  const overlapping = ddr.filter((d) => d.end > from && d.start < to);

  const stateHours: Partial<Record<OpState, number>> = {};
  for (const [s, n] of Object.entries(stateMinutes)) {
    stateHours[s as OpState] = +(n / 60).toFixed(2);
  }

  return {
    from,
    to,
    measuredHours: +(minutes.length / 60).toFixed(2),
    missingHours: +((wallMinutes - minutes.length) / 60).toFixed(2),
    depthStart: depths.length ? depths[0] : null,
    depthEnd: depths.length ? depths[depths.length - 1] : null,
    totalFootage: +footage.toFixed(1),
    onBottomHours: +(onBottom / 60).toFixed(2),
    ropOnBottom: onBottom > 0 ? +((footage / onBottom) * 60).toFixed(1) : null,
    ropOverall: minutes.length > 0 ? +((footage / minutes.length) * 60).toFixed(1) : null,
    ropChannelMean: ropN > 0 ? +(ropSum / ropN).toFixed(2) : null,
    stateHours,
    ddrNptHours: +overlapping.reduce((a, d) => a + d.nptHrs, 0).toFixed(2),
    ddrTotalHours: +overlapping.reduce((a, d) => a + d.durationHrs, 0).toFixed(2),
  };
}

/** Coarse series for charting: one point per N minutes, dispersion preserved. */
export interface SeriesPoint {
  t: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  sd: number | null;
  n: number;
}

/**
 * Downsample a channel for display while keeping the min/max envelope and the
 * standard deviation, so a chart can draw the band as well as the line. This is the
 * whole reason the pipeline stores dispersion per minute rather than just a mean:
 * averaging a 7,330-point series down to 500 pixels would erase exactly the
 * short-timescale variation the anomaly work depends on.
 */
export function buildSeries(
  minutes: MinuteRecord[],
  pick: (m: MinuteRecord) => { mean: number; min: number; max: number; sd: number } | null,
  bucketMinutes: number,
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let i = 0;
  while (i < minutes.length) {
    const t0 = minutes[i].t;
    const vals: { mean: number; min: number; max: number; sd: number }[] = [];
    let j = i;
    while (j < minutes.length && minutes[j].t < t0 + bucketMinutes * MINUTE) {
      const v = pick(minutes[j]);
      if (v) vals.push(v);
      j++;
    }
    if (vals.length) {
      out.push({
        t: t0,
        mean: +(vals.reduce((a, v) => a + v.mean, 0) / vals.length).toFixed(3),
        min: +Math.min(...vals.map((v) => v.min)).toFixed(3),
        max: +Math.max(...vals.map((v) => v.max)).toFixed(3),
        // Root-mean-square of the per-minute deviations: preserves the typical
        // within-minute spread instead of averaging it away.
        sd: +Math.sqrt(vals.reduce((a, v) => a + v.sd * v.sd, 0) / vals.length).toFixed(3),
        n: vals.length,
      });
    } else {
      out.push({ t: t0, mean: null, min: null, max: null, sd: null, n: 0 });
    }
    i = j;
  }
  return out;
}

export const HOUR_MS = HOUR;
