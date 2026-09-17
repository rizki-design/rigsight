import type { MinuteRecord, OpState, DdrRow, FeedGap } from "../src/lib/types.js";

const MINUTE = 60_000;

/**
 * ---------------------------------------------------------------------------
 * OPERATIONAL STATE DETECTION
 * ---------------------------------------------------------------------------
 * The question this answers is the one a drilling engineer actually asks when
 * they open a rig screen: "what is the rig doing right now, and is it a problem?"
 *
 * The glossary offers an obvious rule - Drilling is `ROP > 0`. That rule does not
 * work on this file. The ROP channel never reaches zero: its minimum is 0.02 ft/hr
 * and it sits at 1-3 ft/hr straight through trips and connections, because it is a
 * smoothed vendor channel rather than a raw rate. Used literally it classifies the
 * entire five days as "drilling", including a seven-hour trip out of the hole.
 *
 * So state is derived from what the rig is physically doing instead:
 *
 *   making hole   change in HOLE depth (DMEA) over the minute - the only
 *                 unambiguous evidence that new formation was cut
 *   on bottom     hole depth minus bit depth (DMEA - DBTM) under ~3 ft
 *   bit moving    change in BIT depth (DBTM), signed: down = running in,
 *                 up = pulling out
 *   rotating      surface RPM
 *   pumping       mud flow in (MFIA)
 *   block travel  range of block position (BPOS) within the minute, which is what
 *                 separates a connection from simply sitting still
 *
 * Rules are ordered most-specific first. Each minute is classified independently,
 * then a short smoothing pass removes single-minute flicker (see `smooth`).
 */

export interface StateThresholds {
  makingHoleWindowFt: number;
  windowMin: number;
  onBottomFt: number;
  trippingWindowFt: number;
  trippingWindowMin: number;
  rotatingRpm: number;
  pumpingGpm: number;
  connectionBposRangeFt: number;
}

export const DEFAULT_THRESHOLDS: StateThresholds = {
  /**
   * "Making hole" is judged over a centred 7-minute window rather than minute to
   * minute, because the hole-depth channel does not update smoothly: 7.8% of minutes
   * inside a window that is demonstrably advancing report a change of exactly zero,
   * and the non-zero ticks are quantised around a median of 1.41 ft. Judged one
   * minute at a time, a continuous drilling interval shatters into DRILLING /
   * CIRCULATING / DRILLING confetti - an artefact of the depth channel's update
   * rate, not of anything happening on the rig.
   *
   * 1.0 ft over 7 minutes is roughly 8.6 ft/hr, comfortably below this well's
   * slowest sustained drilling and comfortably above depth-sensor jitter.
   */
  makingHoleWindowFt: 1.0,
  windowMin: 3, // +/- 3 minutes, so a 7-minute centred window
  // Bit within 3 ft of total depth counts as on bottom; this well's bit-depth
  // channel resolves to ~0.2 ft, and 3 ft is well under one joint of pipe.
  onBottomFt: 3,
  /**
   * Tripping is judged over a longer window (+/- 7 min) and a larger threshold
   * (30 ft NET) than hole advance, specifically to separate a trip from a connection.
   *
   * A connection is a round trip: the bit comes up a stand, pipe is added, the bit
   * goes back down, and net displacement over a quarter of an hour is close to zero.
   * A real trip keeps going one way - the 14 Sep pull covers 772 ft in five hours,
   * roughly 39 ft per 15 minutes. Judged on a short window, every connection during
   * fast drilling reads as a brief trip out, which is what the first pass did.
   */
  trippingWindowFt: 30,
  trippingWindowMin: 7,
  rotatingRpm: 20,
  pumpingGpm: 200,
  // A connection swings the blocks through most of a stand; 10 ft of travel in a
  // single minute is the signature.
  connectionBposRangeFt: 10,
};

/** Window-derived context for one minute. Computed once, in `applyStates`. */
interface MinuteContext {
  holeAdvance: number; // ft of new hole across the centred 7-minute window
  bitTravel: number; // net signed bit movement across the longer trip window
}

export function classify(
  m: MinuteRecord,
  ctx: MinuteContext,
  th: StateThresholds = DEFAULT_THRESHOLDS,
): OpState {
  const rpm = m.stats.RPM?.mean ?? 0;
  const flow = m.stats.MFIA?.mean ?? 0;
  const bpos = m.stats.BPOS;
  const bposRange = bpos ? bpos.max - bpos.min : 0;

  const makingHole = ctx.holeAdvance >= th.makingHoleWindowFt;
  const onBottom = m.offBottom !== null && m.offBottom <= th.onBottomFt;
  const rotating = rpm >= th.rotatingRpm;
  const pumping = flow >= th.pumpingGpm;

  // --- making new hole -------------------------------------------------------
  if (makingHole && onBottom) {
    // Rotary drilling turns the whole string from surface. Sliding pushes with a
    // downhole mud motor while the string is held still, so surface RPM is low but
    // the bit is still cutting - and the flow driving the motor is still there.
    return rotating ? "DRILLING" : "SLIDING";
  }

  // --- moving pipe -----------------------------------------------------------
  // Checked before the static cases: a trip is defined by bit movement, and during
  // a trip the pumps are usually off and nothing else looks distinctive. Measured
  // across the window for the same reason as hole advance - the bit-depth channel
  // is quantised, so a steady trip reads as a stutter minute to minute.
  if (!makingHole && Math.abs(ctx.bitTravel) >= th.trippingWindowFt) {
    return ctx.bitTravel > 0 ? "TRIPPING_IN" : "TRIPPING_OUT";
  }

  // --- connection ------------------------------------------------------------
  // Not making hole, not going anywhere, but the blocks are swinging through most
  // of a stand and the bit has come up off bottom: pipe is being added or removed.
  //
  // Note this does NOT require the pumps to be off, which is what the first pass
  // assumed from the glossary. On this rig the flow channel frequently stays above
  // the pumping threshold straight through a connection, so a pumps-off rule found
  // 45 minutes of connections across 3,563 ft of hole - roughly forty connections'
  // worth of activity, almost all of it missed.
  if (
    !makingHole &&
    m.offBottom !== null &&
    m.offBottom > th.onBottomFt &&
    m.offBottom < 120 &&
    bposRange >= th.connectionBposRangeFt
  ) {
    return "CONNECTION";
  }

  // --- turning and pumping but not deepening the well ------------------------
  if (pumping && rotating) {
    // Reaming works the string up and down through a section that is already
    // drilled; circulating holds position and just cleans the hole.
    return Math.abs(m.dBit) > 0.5 ? "REAMING" : "CIRCULATING";
  }
  if (pumping) return "CIRCULATING";

  return "STATIC";
}

/**
 * Remove single-minute flicker with a 5-minute majority vote, then absorb any
 * surviving run shorter than 2 minutes into its neighbour.
 *
 * Without this the ribbon is confetti: one quiet minute mid-connection reads as
 * STATIC, one depth tick mid-ream reads as DRILLING. Operationally those are noise -
 * nobody reports a two-minute trip.
 *
 * The window is deliberately kept short. A real connection runs 3-10 minutes, so a
 * 7-minute vote that only absorbs runs under 3 minutes cannot erase one, while it
 * does clear the single-minute flicker that comes from the depth channel's quantised
 * updates.
 */
export function smooth(states: OpState[], window = 7, minRun = 3): OpState[] {
  const half = Math.floor(window / 2);

  const voted = states.map((_, i) => {
    const counts = new Map<OpState, number>();
    for (let j = Math.max(0, i - half); j <= Math.min(states.length - 1, i + half); j++) {
      counts.set(states[j], (counts.get(states[j]) ?? 0) + 1);
    }
    let best = states[i];
    let bestN = 0;
    for (const [s, n] of counts) {
      // Ties resolve to the minute's own classification, so the vote can only
      // overturn a reading that is genuinely outnumbered.
      if (n > bestN || (n === bestN && s === states[i])) {
        best = s;
        bestN = n;
      }
    }
    return best;
  });

  const out = [...voted];
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j + 1 < out.length && out[j + 1] === out[i]) j++;
    const runLen = j - i + 1;
    if (runLen < minRun && i > 0) {
      const fill = out[i - 1];
      for (let k = i; k <= j; k++) out[k] = fill;
    }
    i = j + 1;
  }
  return out;
}

/**
 * Build the centred window context for every minute.
 *
 * Windows never span a feed gap: a 144-minute blackout sitting inside the window
 * would otherwise be read as 144 minutes of zero progress, or worse, as a single
 * enormous depth jump the instant the feed returns.
 */
function buildContexts(minutes: MinuteRecord[], th: StateThresholds): MinuteContext[] {
  return minutes.map((_, i) => {
    // Short centred window for hole advance.
    let lo = i;
    let hi = i;
    while (lo > 0 && i - lo < th.windowMin && minutes[lo].t - minutes[lo - 1].t === MINUTE) lo--;
    while (hi < minutes.length - 1 && hi - i < th.windowMin && minutes[hi + 1].t - minutes[hi].t === MINUTE) hi++;

    let holeAdvance = 0;
    for (let k = lo + 1; k <= hi; k++) holeAdvance += minutes[k].dHole;

    // Longer centred window for bit travel, so a connection's up-and-back cancels.
    let tlo = i;
    let thi = i;
    while (tlo > 0 && i - tlo < th.trippingWindowMin && minutes[tlo].t - minutes[tlo - 1].t === MINUTE) tlo--;
    while (thi < minutes.length - 1 && thi - i < th.trippingWindowMin && minutes[thi + 1].t - minutes[thi].t === MINUTE) thi++;

    const bitLo = minutes[tlo].bitDepth;
    const bitHi = minutes[thi].bitDepth;
    const bitTravel = bitLo !== null && bitHi !== null ? bitHi - bitLo : 0;

    return { holeAdvance, bitTravel };
  });
}

/** Apply classification + smoothing. */
export function applyStates(
  minutes: MinuteRecord[],
  gaps: FeedGap[],
  th: StateThresholds = DEFAULT_THRESHOLDS,
): void {
  const ctx = buildContexts(minutes, th);
  const raw = minutes.map((m, i) => classify(m, ctx[i], th));
  const sm = smooth(raw);
  minutes.forEach((m, i) => (m.state = sm[i]));

  // A minute that merely borders a gap is still a real measurement, so only the
  // missing minutes themselves are NO_DATA. They have no record of their own, which
  // is exactly why the API returns gaps as a separate list rather than as rows.
  void gaps;
}

/** Contiguous runs of one state - what the UI ribbon and /api/state return. */
export interface StateSpan {
  state: OpState;
  from: number;
  to: number;
  minutes: number;
  depthFrom: number | null;
  depthTo: number | null;
  footage: number;
}

export function toSpans(minutes: MinuteRecord[]): StateSpan[] {
  const spans: StateSpan[] = [];
  let i = 0;
  while (i < minutes.length) {
    let j = i;
    while (
      j + 1 < minutes.length &&
      minutes[j + 1].state === minutes[i].state &&
      // A feed gap ends the span: we cannot claim the rig held one state across
      // time we never measured.
      minutes[j + 1].t - minutes[j].t === MINUTE
    ) {
      j++;
    }
    let footage = 0;
    for (let k = i; k <= j; k++) footage += minutes[k].dHole;
    spans.push({
      state: minutes[i].state,
      from: minutes[i].t,
      to: minutes[j].t + MINUTE,
      minutes: j - i + 1,
      depthFrom: minutes[i].holeDepth,
      depthTo: minutes[j].holeDepth,
      footage: +footage.toFixed(1),
    });
    i = j + 1;
  }
  return spans;
}

/**
 * ---------------------------------------------------------------------------
 * VALIDATION AGAINST THE DRILLER'S OWN REPORT
 * ---------------------------------------------------------------------------
 * The DDR is an independent, human-written account of the same five days, so it is
 * the closest thing to ground truth available here. Each DDR activity code maps to
 * the family of states we would expect the sensors to show, and we measure how
 * often the detector agrees.
 *
 * This is a sanity check, not a target to optimise against. Disagreement is
 * frequently the detector being *right*: a DDR line reading "TIH, 8 hrs" covers the
 * pump-and-circulate breaks inside that trip, which the sensors resolve and the
 * paperwork rounds off.
 */
const ACTIVITY_EXPECTS: Record<string, OpState[]> = {
  DRLROT: ["DRILLING"],
  DRLDD: ["DRILLING", "SLIDING"],
  DRLRS: ["DRILLING", "SLIDING"],
  DRLSLD: ["SLIDING"],
  DRLCMT: ["DRILLING", "SLIDING"],
  TIH: ["TRIPPING_IN"],
  TOH: ["TRIPPING_OUT"],
  CSGPULL: ["TRIPPING_OUT"],
  CC: ["CIRCULATING"],
  CLNOUT: ["CIRCULATING", "REAMING"],
  EQRPR: ["STATIC"],
  OPSUS: ["STATIC"],
  WOC: ["STATIC"],
  BHAPU: ["STATIC"],
  "BHAPU/LD": ["STATIC"],
  TSTSURFEQ: ["STATIC", "CIRCULATING"],
  "DPP/U": ["STATIC"],
  FIT: ["STATIC", "CIRCULATING"],
};

export interface AgreementRow {
  activity: string;
  ddrMinutes: number;
  matchedMinutes: number;
  agreement: number;
  topDetected: { state: OpState; minutes: number }[];
}

export function agreementWithDdr(minutes: MinuteRecord[], ddr: DdrRow[]): {
  overall: number;
  scoredMinutes: number;
  rows: AgreementRow[];
} {
  const byActivity = new Map<string, { ddrMinutes: number; matched: number; detected: Map<OpState, number> }>();

  // Index minutes by timestamp for interval lookup.
  const byTime = new Map<number, MinuteRecord>();
  for (const m of minutes) byTime.set(m.t, m);

  for (const row of ddr) {
    const expects = ACTIVITY_EXPECTS[row.activity];
    if (!expects) continue;

    let e = byActivity.get(row.activity);
    if (!e) byActivity.set(row.activity, (e = { ddrMinutes: 0, matched: 0, detected: new Map() }));

    for (let t = row.start; t < row.end; t += MINUTE) {
      const m = byTime.get(t);
      if (!m) continue; // outside telemetry coverage or inside a gap
      e.ddrMinutes++;
      e.detected.set(m.state, (e.detected.get(m.state) ?? 0) + 1);
      if (expects.includes(m.state)) e.matched++;
    }
  }

  const rows: AgreementRow[] = [];
  let total = 0;
  let matched = 0;
  for (const [activity, e] of byActivity) {
    if (e.ddrMinutes === 0) continue;
    total += e.ddrMinutes;
    matched += e.matched;
    rows.push({
      activity,
      ddrMinutes: e.ddrMinutes,
      matchedMinutes: e.matched,
      agreement: +((100 * e.matched) / e.ddrMinutes).toFixed(1),
      topDetected: [...e.detected.entries()]
        .map(([state, m]) => ({ state, minutes: m }))
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 3),
    });
  }
  rows.sort((a, b) => b.ddrMinutes - a.ddrMinutes);

  return {
    overall: total ? +((100 * matched) / total).toFixed(1) : 0,
    scoredMinutes: total,
    rows,
  };
}

/** Stamp each telemetry minute with the hole size the DDR says was open at the time. */
export function applyHoleSize(minutes: MinuteRecord[], ddr: DdrRow[]): void {
  const sized = ddr.filter((d) => d.holeSize !== null).sort((a, b) => a.start - b.start);
  if (!sized.length) return;

  let i = 0;
  let current: string | null = null;
  for (const m of minutes) {
    while (i < sized.length && sized[i].start <= m.t) {
      current = sized[i].holeSize;
      i++;
    }
    m.holeSize = current;
  }
}
