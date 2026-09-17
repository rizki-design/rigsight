import { readFileSync } from "node:fs";
import { parseCsv, parseFeedTimestamp, num } from "./lib/csv.js";
import { mean, sd, quantileSorted, median, normalisedMad, dropHeldFrames } from "./lib/stats.js";
import {
  CHANNELS,
  type ChannelCode,
  type ChannelStats,
  type MinuteRecord,
  type FeedGap,
  type QualityFinding,
} from "../src/lib/types.js";

const MINUTE = 60_000;

/** Separator for building a row fingerprint - a byte that cannot occur in the CSV. */
const RECORD_SEP = "\u0001";

/** A single cleaned sample, plus whether its source row repeated the row before it. */
interface Sample {
  t: number;
  v: Partial<Record<ChannelCode, number>>;
  dupOfPrev: boolean;
}

export interface TelemetryParseResult {
  minutes: MinuteRecord[];
  gaps: FeedGap[];
  findings: QualityFinding[];
  meta: {
    rawRows: number;
    malformedRows: number;
    from: number;
    to: number;
    rowsPerMinute: { min: number; p50: number; mean: number; max: number };
    coveredMinutes: number;
    missingMinutes: number;
  };
}

/**
 * ---------------------------------------------------------------------------
 * HOW THE IRREGULAR FEED IS HANDLED  (the central data decision of this project)
 * ---------------------------------------------------------------------------
 * The feed carries MINUTE precision only. ~34 rows share each minute stamp
 * (min 1, median 35, max 60), i.e. roughly one reading every 1.7 s, and there is
 * no seconds field. Row order is the only within-minute ordering information.
 *
 * Decision: bucket by the given minute and treat within-minute row order as-is.
 * I do NOT synthesise sub-minute timestamps and then present them as measured.
 *
 * What that buys, and what it costs:
 *  - Every statistic below is computed over the RAW samples inside the bucket.
 *    Nothing is interpolated, resampled onto a grid, or smoothed before
 *    aggregation. So within-minute variance - which is the entire stick-slip
 *    signal - is measured on real samples.
 *  - The minute is therefore the atomic time unit of this system. Nothing in the
 *    API or the UI claims sub-minute resolution, because the data cannot support it.
 *  - The cost, stated plainly: a genuine stick-slip cycle has a period of roughly
 *    1-10 s. At ~1.7 s sampling we are at the edge of Nyquist and the signal is
 *    aliased. That is why stick-slip is published as a relative severity INDEX
 *    with a stated confidence, not as a calibrated stick-slip percentage.
 *
 * Gaps are never bridged. 46 gaps totalling 351 missing minutes exist, including
 * a 144-minute blackout on 10 Sep. Charts break the line across them and rate
 * denominators exclude them, so we never report footage-per-hour against wall
 * clock time the rig was not actually being measured.
 */
export function parseTelemetry(path: string): TelemetryParseResult {
  const rows = parseCsv(readFileSync(path, "utf8"));

  // Three header rows: plain label / sensor code / unit.
  const codes = rows[1].map((c) => c.trim());
  const body = rows.slice(3);

  const colOf: Partial<Record<ChannelCode, number>> = {};
  for (const ch of CHANNELS) {
    const i = codes.indexOf(ch);
    if (i < 0) throw new Error(`telemetry: expected channel column ${ch}`);
    colOf[ch] = i;
  }
  const tCol = codes.indexOf("dtsrv");

  const samples: Sample[] = [];
  let malformed = 0;
  let prevRaw = "";

  // Counters for the quality report - every cleaning action is countable.
  let nonNumeric = 0;
  const nonNumericExamples = new Set<string>();
  let dbtmZero = 0;
  let wobNegative = 0;
  let dupRows = 0;

  for (const r of body) {
    if (r.length !== codes.length) {
      malformed++;
      continue;
    }
    const t = parseFeedTimestamp(r[tCol]);
    if (t === null) {
      malformed++;
      continue;
    }

    const key = r.join(RECORD_SEP);
    const isDup = key === prevRaw;
    if (isDup) dupRows++;
    prevRaw = key;

    const v: Partial<Record<ChannelCode, number>> = {};
    for (const ch of CHANNELS) {
      const raw = r[colOf[ch]!];
      const n = num(raw);

      if (n === null) {
        // Genuinely un-parseable cell. In this pack that is the 12 "5.0E" cells in
        // WOB - a scientific-notation literal truncated on export. Left as missing;
        // coercing to 0 would fabricate an off-bottom reading in the middle of a
        // drilling interval.
        if (raw !== undefined && raw.trim() !== "") {
          nonNumeric++;
          if (nonNumericExamples.size < 4) nonNumericExamples.add(`${ch}="${raw.trim()}"`);
        }
        continue;
      }

      // DBTM == 0 is not "the bit is at surface", it is "no valid bit depth".
      // Every one of these rows falls inside 9 Sep 08:50-14:55, which the DDR shows
      // as mud-pump performance testing and BHA make-up with the string out of the
      // hole. Plotted literally it makes the bit teleport to surface and destroys
      // the depth-vs-time chart.
      if (ch === "DBTM" && n === 0) {
        dbtmZero++;
        continue;
      }

      if (ch === "WOB" && n < 0) wobNegative++; // kept: real off-bottom tension / zero offset

      v[ch] = n;
    }
    samples.push({ t, v, dupOfPrev: isDup });
  }

  // ---- bucket by minute -----------------------------------------------------
  const buckets = new Map<number, Sample[]>();
  for (const s of samples) {
    let b = buckets.get(s.t);
    if (!b) buckets.set(s.t, (b = []));
    b.push(s);
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);
  const from = times[0];
  const to = times[times.length - 1];

  // ---- gaps -----------------------------------------------------------------
  const gaps: FeedGap[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = (times[i] - times[i - 1]) / MINUTE;
    if (d > 1) gaps.push({ from: times[i - 1], to: times[i], minutes: d - 1 });
  }
  const missingMinutes = gaps.reduce((a, g) => a + g.minutes, 0);

  const counts = times.map((t) => buckets.get(t)!.length).sort((a, b) => a - b);

  // ---- per-minute records ---------------------------------------------------
  const minutes: MinuteRecord[] = [];
  let prevHole: number | null = null;
  let prevBit: number | null = null;

  for (const t of times) {
    const b = buckets.get(t)!;
    const stats: Partial<Record<ChannelCode, ChannelStats>> = {};

    for (const ch of CHANNELS) {
      const vals: number[] = [];
      for (const s of b) {
        const x = s.v[ch];
        if (x !== undefined) vals.push(x);
      }
      if (!vals.length) continue;
      const srt = [...vals].sort((x, y) => x - y);
      stats[ch] = {
        n: vals.length,
        mean: mean(vals),
        min: srt[0],
        max: srt[srt.length - 1],
        sd: sd(vals),
        p10: quantileSorted(srt, 0.1),
        p50: quantileSorted(srt, 0.5),
        p90: quantileSorted(srt, 0.9),
      };
    }

    // Hole depth only ever increases - take the deepest reading in the minute.
    const holeDepth = stats.DMEA ? stats.DMEA.max : null;
    const bitDepth = stats.DBTM ? stats.DBTM.mean : null;

    const dHole = holeDepth !== null && prevHole !== null ? Math.max(0, holeDepth - prevHole) : 0;
    const dBit = bitDepth !== null && prevBit !== null ? bitDepth - prevBit : 0;

    // ---- torque, cleaned for the zero-fill artefact -------------------------
    // While the string is turning (RPM > 20) the TORQUE channel still reports an
    // exact 0 on a median 12% of samples, in 72% of rotating minutes. RPM shows the
    // same artefact in only 4.8% of those minutes, which is what rules out "the
    // string actually stopped" and identifies it as a per-channel dropout. Left in,
    // it manufactures a full-amplitude torque oscillation every single rotating
    // minute and a naive variance detector fires on 100% of rotating time.
    const rpmMean = stats.RPM?.mean ?? 0;
    const rotating = rpmMean > 20;

    const rawTorque: number[] = [];
    for (const s of b) {
      const x = s.v.TORQUE;
      if (x !== undefined) rawTorque.push(x);
    }

    let torqueZeroFill = 0;
    let kept = rawTorque;
    if (rotating) {
      kept = rawTorque.filter((v) => v > 0);
      torqueZeroFill = rawTorque.length - kept.length;
    }
    // Held frames repeat the previous value when no new reading arrived; leaving
    // them in pulls dispersion toward zero and masks real oscillation.
    kept = dropHeldFrames(kept);

    const tqMed = kept.length >= 4 ? median(kept) : null;
    const tqNMad = rotating ? normalisedMad(kept) : null;
    const tqPtp =
      tqMed !== null && tqMed > 0 && kept.length >= 4
        ? (Math.max(...kept) - Math.min(...kept)) / tqMed
        : null;

    minutes.push({
      t,
      n: b.length,
      dupRows: b.filter((s) => s.dupOfPrev).length,
      stats,
      holeDepth,
      bitDepth,
      offBottom: holeDepth !== null && bitDepth !== null ? holeDepth - bitDepth : null,
      dHole,
      dBit,
      ropCalc: dHole * 60,
      torqueValid: kept.length,
      torqueZeroFill,
      torqueMedian: tqMed,
      torqueNMad: tqNMad,
      torquePtp: tqPtp,
      state: "STATIC", // filled in by etl/state.ts
      holeSize: null, // filled in from the DDR activity timeline
    });

    if (holeDepth !== null) prevHole = holeDepth;
    if (bitDepth !== null) prevBit = bitDepth;
  }

  const totalRows = samples.length;
  const pct = (n: number) => +((100 * n) / totalRows).toFixed(2);
  const totalZeroFill = minutes.reduce((a, m) => a + m.torqueZeroFill, 0);

  const findings: QualityFinding[] = [
    {
      id: "minute-precision",
      severity: "critical",
      title: "Timestamps carry minute precision only",
      detail: `${totalRows.toLocaleString()} rows share just ${times.length.toLocaleString()} distinct minute stamps (median ${counts[Math.floor(counts.length / 2)]} rows/min, max ${counts[counts.length - 1]}). There is no seconds field; within-minute order is implied by row order alone.`,
      affectedRows: totalRows,
      affectedPct: 100,
      action:
        "The minute is the atomic time unit. Statistics are computed over raw samples inside each bucket - nothing is resampled onto a synthetic grid, so within-minute variance survives.",
    },
    {
      id: "torque-zero-fill",
      severity: "critical",
      title: "TORQUE reports exact 0 while the string is turning",
      detail:
        "In 72% of rotating minutes the torque channel returns an exact 0 on a median 12% of samples, while RPM in those same minutes is non-zero and climbing. RPM shows the same artefact in only 4.8% of rotating minutes, so this is a torque-channel dropout, not the string stopping.",
      affectedRows: totalZeroFill,
      affectedPct: pct(totalZeroFill),
      action:
        "Exact zeros are excluded from torque statistics while RPM > 20. Left in, they manufacture a full-amplitude oscillation and a variance-based stick-slip detector fires on 100% of rotating time.",
    },
    {
      id: "rop-never-zero",
      severity: "critical",
      title: "The ROP channel never reaches zero",
      detail:
        "ROP bottoms out at 0.02 ft/hr, only 48 of 249,395 rows fall below 0.05, and the file holds just 562 distinct ROP values - it is a smoothed/derived channel, not a raw rate. The glossary rule 'ROP = 0 means not making hole' does not hold in this export: ROP sits at 1-3 ft/hr straight through trips and connections.",
      affectedRows: totalRows,
      affectedPct: 100,
      action:
        "Operational state is derived from change in hole depth (DMEA), bit movement and block position - never from ROP > 0. A separate ropCalc = dDMEA/dt is published next to the vendor channel so the two can be compared.",
    },
    {
      id: "dbtm-zero",
      severity: "warn",
      title: "Bit depth reads 0 for a six-hour block",
      detail: `${dbtmZero.toLocaleString()} rows report DBTM = 0, all inside 9 Sep 08:50-14:55. The DDR for that window shows mud-pump performance testing and BHA make-up with the string out of the hole, so 0 means "no valid bit depth", not "bit at surface".`,
      affectedRows: dbtmZero,
      affectedPct: pct(dbtmZero),
      action:
        "Treated as missing. Plotted literally it drops the bit-depth trace to surface and ruins the depth-vs-time chart.",
    },
    {
      id: "non-numeric",
      severity: "warn",
      title: "Non-numeric cells inside a numeric channel",
      detail: `${nonNumeric} cells fail numeric parsing (${[...nonNumericExamples].join(", ")}) - scientific-notation literals truncated on export.`,
      affectedRows: nonNumeric,
      affectedPct: pct(nonNumeric),
      action:
        "Left as missing rather than coerced to 0, which would fabricate a zero-weight-on-bit reading while drilling.",
    },
    {
      id: "held-frames",
      severity: "warn",
      title: "Repeated (held) sensor frames",
      detail: `${dupRows.toLocaleString()} rows are byte-identical to the row before them - the feed re-publishes the last value when no new reading arrived.`,
      affectedRows: dupRows,
      affectedPct: pct(dupRows),
      action:
        "Counted and reported. Consecutive repeats are collapsed before computing torque dispersion, because leaving them in pulls variance toward zero and hides real oscillation.",
    },
    {
      id: "feed-gaps",
      severity: "warn",
      title: "Feed gaps, including a 144-minute blackout",
      detail: `${gaps.length} gaps totalling ${missingMinutes} missing minutes. The largest runs 10 Sep 10:03-12:27 (144 min), in the middle of 8-1/2" drilling.`,
      affectedRows: 0,
      affectedPct: 0,
      action:
        "Gaps are never interpolated. Chart lines break across them and rate denominators exclude them, so footage-per-hour is never diluted by time the rig was not measured.",
    },
    {
      id: "wob-negative",
      severity: "critical",
      title: "The weight-on-bit channel has a zero-offset fault",
      detail: `${wobNegative.toLocaleString()} rows report WOB below zero (minimum -29.6 klb). This is not confined to off-bottom time: across the 881 minutes where the well is unambiguously being deepened - hole depth advancing, bit on bottom, 40+ RPM - WOB reads negative 58% of the time, with a median of -1.1 klb and a 5th percentile of -12.7 klb. A bit cutting rock at 90-170 ft/hr is not doing it under negative weight.`,
      affectedRows: wobNegative,
      affectedPct: pct(wobNegative),
      action:
        "The absolute WOB reading is treated as untrustworthy. Nothing gates on WOB level: on-bottom is established from bit depth against hole depth, and the stick-slip rule uses WOB's standard deviation, which is immune to a constant offset and is the more correct physics anyway. Worth raising with the rig - a mis-tared WOB sensor also misleads the driller at the brake.",
    },
    {
      id: "torque-units",
      severity: "warn",
      title: "The TORQUE unit row disagrees with the values",
      detail:
        'The header unit row says "kft.lb", but the channel reaches 5,979 - and the offset-well table caps DRL_TORQUE for the same 8-1/2" section at 7,700. The two are plainly on the same scale, so the telemetry is ft-lb and the unit row is mislabelled.',
      affectedRows: totalRows,
      affectedPct: 100,
      action:
        "Treated as ft-lb throughout so the offset-envelope comparison is like-for-like. Taken at face value, every torque reading would appear 1000x over the historical ceiling.",
    },
    {
      id: "mfop-scale",
      severity: "warn",
      title: "Mud Flow Out is not the percentage the glossary describes",
      detail:
        "MFOP is documented as flow-out as a percentage of flow-in, expected near 100%. With pumps running above 300 gpm it actually sits at a median of 20 and never exceeds 69 - an uncalibrated flow-out sensor reading, not a ratio.",
      affectedRows: totalRows,
      affectedPct: 100,
      action:
        "The glossary's 'MFOP near 100%' rule is not applied literally. Flow imbalance is scored as relative drift from the channel's own rolling baseline and published at LOW confidence.",
    },
  ];

  return {
    minutes,
    gaps,
    findings,
    meta: {
      rawRows: totalRows,
      malformedRows: malformed,
      from,
      to,
      rowsPerMinute: {
        min: counts[0],
        p50: counts[Math.floor(counts.length / 2)],
        mean: +(totalRows / times.length).toFixed(1),
        max: counts[counts.length - 1],
      },
      coveredMinutes: times.length,
      missingMinutes,
    },
  };
}
