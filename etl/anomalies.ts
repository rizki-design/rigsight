import { median, quantileSorted } from "./lib/stats.js";
import type {
  MinuteRecord,
  Anomaly,
  Severity,
  OffsetEnvelope,
  ChannelCode,
} from "../src/lib/types.js";

const MINUTE = 60_000;

/**
 * ---------------------------------------------------------------------------
 * ANOMALY DETECTION
 * ---------------------------------------------------------------------------
 * Four detectors, all rule-based. Rules rather than a learned model, deliberately:
 * this pack contains five days of one well with no labelled events, which is far
 * too little to train anything that would generalise - and on a rig, a flag nobody
 * can explain is a flag nobody acts on. Every detector here publishes the numbers
 * it fired on, so a driller can disagree with it on the evidence.
 *
 * Three design rules shared by all of them:
 *
 *   1. GATE FIRST. Each detector only looks at minutes where its signal is
 *      physically meaningful. Torque variance means nothing while the string is
 *      stationary; a pressure drop means nothing with the pumps off. Most false
 *      positives in this kind of system are a rule applied in the wrong rig state.
 *
 *   2. REQUIRE PERSISTENCE. Single-minute excursions are noise at this sampling
 *      rate. Every detector requires consecutive qualifying minutes before it
 *      raises anything, and adjacent qualifying minutes merge into one event.
 *
 *   3. PUBLISH CONFIDENCE AND CAVEAT. Two of these signals are compromised by the
 *      data itself (torque aliasing, the mis-scaled flow-out channel). They ship
 *      with that stated on the event rather than buried in a footnote.
 */

export interface DetectorConfig {
  stickSlip: { watch: number; warn: number; alarm: number; minRpm: number; maxWobSd: number; maxRpmCov: number; minTorque: number; minMinutes: number };
  washout: { dropPct: number; flowTolPct: number; minMinutes: number; minSpp: number; baselineMin: number };
  overpull: { klbOver: number; baselineMin: number; minMinutes: number };
  flow: { driftPct: number; minMinutes: number };
}

/**
 * Thresholds are calibrated against this well's own measured distributions rather
 * than pulled from a textbook - the torque dispersion index in particular is a
 * relative measure and has no universal scale. Percentiles quoted below are over
 * the 257 on-bottom rotating minutes in this file.
 */
export const DEFAULT_CONFIG: DetectorConfig = {
  stickSlip: {
    watch: 0.95, // p75 of on-bottom rotating minutes
    warn: 1.1, //  p90
    alarm: 1.21, // p95
    minRpm: 40,
    /**
     * Stick-slip is torque swinging while weight on bit holds steady, so what
     * matters is WOB's STABILITY, not its level - which is fortunate, because the
     * absolute WOB reading on this rig cannot be trusted. Across 881 minutes where
     * the well is unambiguously being deepened (hole advancing, bit on bottom,
     * 40+ RPM) the WOB channel reads negative 58% of the time, median -1.1 klb.
     * That is a zero-offset fault in the surface sensor, not the string floating.
     *
     * Gating on "WOB above some positive threshold" would therefore throw away most
     * genuine drilling. Standard deviation is immune to a constant offset, so the
     * gate uses that instead - which is also the more correct physics.
     */
    maxWobSd: 3.0,
    // If surface RPM is swinging too, the driller is changing something and the
    // torque response is a consequence, not stick-slip.
    maxRpmCov: 0.15,
    minTorque: 300,
    minMinutes: 3,
  },
  washout: {
    dropPct: 8,
    flowTolPct: 3,
    minMinutes: 5, // a washout does not heal; a pump stroke change does
    minSpp: 400,
    baselineMin: 20,
  },
  overpull: {
    klbOver: 10, // the DDR narrative for this well reports drag in 10-12 klb terms
    baselineMin: 30,
    minMinutes: 1,
  },
  flow: { driftPct: 25, minMinutes: 10 },
};

const sev = (v: number, watch: number, warn: number, alarm: number): Severity | null =>
  v >= alarm ? "ALARM" : v >= warn ? "WARN" : v >= watch ? "WATCH" : null;

/** Merge consecutive flagged minutes into events. */
function groupRuns<T extends { t: number }>(flagged: T[], minMinutes: number): T[][] {
  const runs: T[][] = [];
  let cur: T[] = [];
  for (const f of flagged) {
    if (cur.length && f.t - cur[cur.length - 1].t === MINUTE) cur.push(f);
    else {
      if (cur.length >= minMinutes) runs.push(cur);
      cur = [f];
    }
  }
  if (cur.length >= minMinutes) runs.push(cur);
  return runs;
}

const fmt = (n: number, d = 1) => +n.toFixed(d);

/* ------------------------------------------------------------------ */
/* 1. STICK-SLIP                                                       */
/* ------------------------------------------------------------------ */
/**
 * Stick-slip is the drillstring winding up against downhole friction and then
 * releasing, so the bit turns in a jerky cycle instead of smoothly. The surface
 * symptom is torque oscillating hard while weight on bit stays roughly steady.
 *
 * Two data problems have to be dealt with before the signal is usable:
 *
 *   (a) The torque channel drops to an exact 0 on a median 12% of samples while the
 *       string is demonstrably still turning. Those are already stripped upstream in
 *       parse-telemetry.ts, along with repeated held frames.
 *
 *   (b) What remains is still spiky, so standard deviation - which is dominated by
 *       outliers - would mostly measure the leftover dropouts. The dispersion metric
 *       here is normalised MAD (1.4826 x median absolute deviation / median), which
 *       ignores them.
 *
 * The honest limitation, stated on every event this raises: real stick-slip cycles
 * at 1-10 s against ~1.7 s sampling are at the edge of Nyquist, so the feed is
 * aliased. The index ranks severity reliably; it is not a calibrated stick-slip
 * percentage, and it cannot recover cycle frequency. Confidence is therefore MEDIUM
 * everywhere. Fixing this needs 1 Hz+ torque, not a better algorithm.
 */
export function detectStickSlip(minutes: MinuteRecord[], cfg = DEFAULT_CONFIG): Anomaly[] {
  const c = cfg.stickSlip;

  const flagged = minutes.filter((m) => {
    const rpm = m.stats.RPM;
    const wob = m.stats.WOB;
    if (!rpm || rpm.mean < c.minRpm) return false;
    // On bottom is established by bit depth against hole depth, which is reliable,
    // rather than by a positive WOB reading, which on this rig is not.
    if (m.offBottom === null || m.offBottom > 3) return false;
    if (!wob || wob.sd > c.maxWobSd) return false; // WOB must be holding steady
    if (rpm.mean > 0 && rpm.sd / rpm.mean > c.maxRpmCov) return false; // driller is changing RPM
    if (m.torqueNMad === null || m.torqueMedian === null) return false;
    if (m.torqueMedian < c.minTorque) return false;
    if (m.torqueValid < 10) return false; // too little left after cleaning to trust
    return m.torqueNMad >= c.watch;
  });

  return groupRuns(flagged, c.minMinutes).map((run, i) => {
    const peak = Math.max(...run.map((m) => m.torqueNMad!));
    const s = sev(peak, c.watch, c.warn, c.alarm) ?? "WATCH";
    const tq = median(run.map((m) => m.torqueMedian!));
    const rpm = median(run.map((m) => m.stats.RPM!.mean));
    const wob = median(run.map((m) => m.stats.WOB?.mean ?? 0));

    return {
      id: `ss-${i + 1}`,
      type: "STICK_SLIP" as const,
      severity: s,
      confidence: "MEDIUM" as const,
      from: run[0].t,
      to: run[run.length - 1].t + MINUTE,
      durationMin: run.length,
      depthFrom: run[0].holeDepth,
      depthTo: run[run.length - 1].holeDepth,
      headline: `Torque oscillating hard over ${run.length} min at ${fmt(run[0].holeDepth ?? 0, 0)} ft - median torque ${fmt(tq, 0)} ft-lb swinging while WOB held near ${fmt(wob)} klb and RPM steady at ${fmt(rpm, 0)}.`,
      evidence: {
        torqueDispersionIndex: fmt(peak, 2),
        thresholdCrossed: s === "ALARM" ? c.alarm : s === "WARN" ? c.warn : c.watch,
        medianTorqueFtLb: fmt(tq, 0),
        medianRpm: fmt(rpm, 0),
        rpmSteadiness: fmt(median(run.map((m) => m.stats.RPM!.sd / m.stats.RPM!.mean)), 3),
        medianWobKlb: fmt(wob),
        wobSteadinessKlb: fmt(median(run.map((m) => m.stats.WOB?.sd ?? 0)), 2),
        samplesUsedPerMin: Math.round(median(run.map((m) => m.torqueValid))),
        zeroFillDropped: Math.round(median(run.map((m) => m.torqueZeroFill))),
      },
      caveat:
        "Torque is sampled at ~1.7 s against a stick-slip period of roughly 1-10 s, so the signal is aliased. Treat this as a relative severity ranking, not a calibrated stick-slip percentage - it cannot recover cycle frequency. Confirming it properly needs 1 Hz or faster torque.",
    };
  });
}

/* ------------------------------------------------------------------ */
/* 2. WASHOUT                                                          */
/* ------------------------------------------------------------------ */
/**
 * A washout is a hole worn through the drillstring or bit: mud escapes before it
 * reaches the bit, so the pressure needed to push it falls even though the pumps
 * have not changed. Surface symptom is standpipe pressure dropping while flow in
 * holds steady.
 *
 * The confounders are everything else that legitimately drops SPP - taking a pump
 * offline, coming off bottom, a connection, a mud-weight change. These are excluded
 * by requiring flow to hold within 3% across the window, by refusing to score any
 * minute that is not in a steady pumping state, and by requiring the drop to
 * PERSIST. That last one does most of the work: a real washout does not recover,
 * while a stroke-rate adjustment settles within a minute or two.
 *
 * Baseline is a trailing 20-minute median rather than a fixed value, so the rule
 * follows the normal pressure ramp as the hole deepens instead of firing on it.
 */
export function detectWashout(minutes: MinuteRecord[], cfg = DEFAULT_CONFIG): Anomaly[] {
  const c = cfg.washout;
  const flagged: { t: number; m: MinuteRecord; dropPct: number; baseline: number; spp: number; flow: number }[] = [];

  for (let i = c.baselineMin; i < minutes.length; i++) {
    const m = minutes[i];
    if (m.state !== "DRILLING" && m.state !== "SLIDING" && m.state !== "CIRCULATING") continue;

    const spp = m.stats.SPP?.mean ?? 0;
    const flow = m.stats.MFIA?.mean ?? 0;
    if (spp < c.minSpp || flow < 300) continue;

    // Trailing window must be contiguous - never compare across a feed gap.
    const win = minutes.slice(i - c.baselineMin, i);
    if (win.length < c.baselineMin) continue;
    if (m.t - win[0].t !== c.baselineMin * MINUTE) continue;

    const baseSpp = median(win.map((w) => w.stats.SPP?.mean ?? 0).filter((v) => v > 0));
    const baseFlow = median(win.map((w) => w.stats.MFIA?.mean ?? 0).filter((v) => v > 0));
    if (baseSpp < c.minSpp || baseFlow < 300) continue;

    const dropPct = ((baseSpp - spp) / baseSpp) * 100;
    const flowDeltaPct = (Math.abs(flow - baseFlow) / baseFlow) * 100;

    if (dropPct >= c.dropPct && flowDeltaPct <= c.flowTolPct) {
      flagged.push({ t: m.t, m, dropPct, baseline: baseSpp, spp, flow });
    }
  }

  return groupRuns(flagged, c.minMinutes).map((run, i) => {
    const peak = Math.max(...run.map((r) => r.dropPct));
    const s: Severity = peak >= 20 ? "ALARM" : peak >= 13 ? "WARN" : "WATCH";
    const first = run[0];

    return {
      id: `wo-${i + 1}`,
      type: "WASHOUT" as const,
      severity: s,
      confidence: "MEDIUM" as const,
      from: run[0].t,
      to: run[run.length - 1].t + MINUTE,
      durationMin: run.length,
      depthFrom: first.m.holeDepth,
      depthTo: run[run.length - 1].m.holeDepth,
      headline: `Standpipe pressure down ${fmt(peak)}% for ${run.length} min at ${fmt(first.m.holeDepth ?? 0, 0)} ft while flow in held at ${fmt(first.flow, 0)} gpm - possible washout.`,
      evidence: {
        sppDropPct: fmt(peak),
        baselineSppPsi: fmt(first.baseline, 0),
        lowestSppPsi: fmt(Math.min(...run.map((r) => r.spp)), 0),
        flowInGpm: fmt(first.flow, 0),
        flowChangePct: fmt(
          (Math.abs(run[run.length - 1].flow - first.flow) / first.flow) * 100,
          2,
        ),
        sustainedMinutes: run.length,
      },
      caveat:
        "Pressure alone cannot separate a drillstring washout from a bit nozzle loss or a pump-side problem. This flags the pattern for a driller to confirm against pump strokes and a pressure test - it is not a diagnosis.",
    };
  });
}

/* ------------------------------------------------------------------ */
/* 3. OVERPULL / DRAG                                                  */
/* ------------------------------------------------------------------ */
/**
 * While pulling out of the hole, hookload cycles between the slips (~20 klb) and the
 * full hanging weight of the string (~145 klb on this well). If the string snags on
 * a tight spot, the pull needed to free it spikes above that hanging weight. The
 * driller calls this drag or overpull, and it is an early warning for a stuck pipe.
 *
 * Included because it is the one detector in this set that can be checked against an
 * independent human record: the DDR narrative for 14 Sep reports drag of 10-12 klb
 * at four named depths during the trip out. If the detector is sound it should find
 * those depths on the sensor feed alone, without ever reading the comment.
 *
 * Baseline is a trailing median of per-minute peak hookload over 30 minutes of
 * tripping, which tracks the string getting lighter as stands come off.
 */
export function detectOverpull(minutes: MinuteRecord[], cfg = DEFAULT_CONFIG): Anomaly[] {
  const c = cfg.overpull;
  const flagged: { t: number; m: MinuteRecord; peak: number; baseline: number; over: number }[] = [];

  /**
   * Scored across a trip-out EPISODE, not only on minutes classified TRIPPING_OUT.
   *
   * This distinction was found the hard way and it matters. The worst drag event in
   * this file - 172.7 klb at 3465 ft on the 14 Sep pull, the highest hookload
   * anywhere in the five days - was initially missed, because when the string is
   * genuinely hung up the blocks stop moving while the driller pulls against it. Bit
   * depth stops changing, so the state machine correctly reports STATIC, and a
   * detector gated on "currently tripping" skips exactly the minutes that matter
   * most. The harder the string is stuck, the more certainly it is missed.
   *
   * So a minute qualifies if it sits inside a window of active tripping out, which
   * keeps the stalled minutes in scope while still excluding drilling and connections.
   */
  const CONTEXT = 10;
  const inTripOut = minutes.map((_, i) => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(minutes.length - 1, i + CONTEXT); j++) {
      if (minutes[j].state === "TRIPPING_OUT") return true;
    }
    return false;
  });

  for (let i = 0; i < minutes.length; i++) {
    const m = minutes[i];
    if (!inTripOut[i]) continue;
    // Still must be off bottom: a hookload peak with the bit on bottom is weight
    // transfer, not drag.
    if (m.offBottom === null || m.offBottom <= 3) continue;
    const hk = m.stats.HKLA;
    if (!hk) continue;

    // Baseline from trailing minutes of ACTIVE tripping only - the stalled minutes
    // we now score must not also set the reference they are judged against.
    const win: number[] = [];
    for (let j = i - 1; j >= 0 && win.length < c.baselineMin; j--) {
      if (minutes[j + 1].t - minutes[j].t !== MINUTE) break;
      if (minutes[j].state !== "TRIPPING_OUT") continue;
      const h = minutes[j].stats.HKLA;
      if (h) win.push(h.max);
    }
    if (win.length < 10) continue;

    // Compare against the upper end of the trailing distribution: the median of all
    // per-minute maxima sits between the slips value and the hoisting value, so the
    // p75 is the honest "normal pick-up weight" reference.
    const baseline = quantileSorted([...win].sort((a, b) => a - b), 0.75);
    if (baseline < 50) continue; // string too light for drag to be meaningful

    const over = hk.max - baseline;
    if (over >= c.klbOver) flagged.push({ t: m.t, m, peak: hk.max, baseline, over });
  }

  return groupRuns(flagged, c.minMinutes).map((run, i) => {
    const peak = Math.max(...run.map((r) => r.over));
    const s: Severity = peak >= 25 ? "ALARM" : peak >= 15 ? "WARN" : "WATCH";
    const worst = run.find((r) => r.over === peak)!;

    return {
      id: `op-${i + 1}`,
      type: "OVERPULL" as const,
      severity: s,
      confidence: "HIGH" as const,
      from: run[0].t,
      to: run[run.length - 1].t + MINUTE,
      durationMin: run.length,
      depthFrom: worst.m.bitDepth,
      depthTo: run[run.length - 1].m.bitDepth,
      headline: `Overpull of ${fmt(peak)} klb while tripping out at ${fmt(worst.m.bitDepth ?? 0, 0)} ft - hookload peaked at ${fmt(worst.peak)} klb against a normal pick-up of ${fmt(worst.baseline)} klb.`,
      evidence: {
        overpullKlb: fmt(peak),
        peakHookloadKlb: fmt(worst.peak),
        normalPickupKlb: fmt(worst.baseline),
        bitDepthFt: fmt(worst.m.bitDepth ?? 0, 0),
        sustainedMinutes: run.length,
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* 4. FLOW IMBALANCE                                                   */
/* ------------------------------------------------------------------ */
/**
 * Flow out drifting away from flow in is how losses (mud disappearing into the
 * formation) and kicks (formation fluid entering the well) first show up, so it is
 * worth having. It ships at LOW confidence for a data reason, not a logic one.
 *
 * The glossary defines MFOP as flow-out as a percentage of flow-in, expected near
 * 100%. In this export, with pumps above 300 gpm, MFOP has a median of 20 and never
 * exceeds 69 - it is an uncalibrated sensor reading, not a ratio. So the documented
 * "MFOP near 100%" rule cannot be applied, and the absolute value carries no
 * meaning we can verify.
 *
 * What is still usable is the channel's behaviour relative to itself: a sharp,
 * sustained drift away from its own recent baseline while flow in holds steady is
 * worth a look regardless of the unit. That is what this detects, and it is
 * labelled as needing a unit check before anyone acts on it.
 */
export function detectFlowImbalance(minutes: MinuteRecord[], cfg = DEFAULT_CONFIG): Anomaly[] {
  const c = cfg.flow;
  const BASE = 30;
  const flagged: { t: number; m: MinuteRecord; drift: number; baseline: number; mfop: number }[] = [];

  for (let i = BASE; i < minutes.length; i++) {
    const m = minutes[i];
    if (m.state !== "DRILLING" && m.state !== "SLIDING" && m.state !== "CIRCULATING") continue;

    const mfop = m.stats.MFOP?.mean ?? 0;
    const flow = m.stats.MFIA?.mean ?? 0;
    if (flow < 300 || mfop <= 0) continue;

    const win = minutes.slice(i - BASE, i);
    if (m.t - win[0].t !== BASE * MINUTE) continue;

    const baseMfop = median(win.map((w) => w.stats.MFOP?.mean ?? 0).filter((v) => v > 0));
    const baseFlow = median(win.map((w) => w.stats.MFIA?.mean ?? 0).filter((v) => v > 0));
    if (baseMfop <= 0 || baseFlow < 300) continue;
    if ((Math.abs(flow - baseFlow) / baseFlow) * 100 > 5) continue; // flow in must be steady

    const drift = ((mfop - baseMfop) / baseMfop) * 100;
    if (Math.abs(drift) >= c.driftPct) flagged.push({ t: m.t, m, drift, baseline: baseMfop, mfop });
  }

  return groupRuns(flagged, c.minMinutes).map((run, i) => {
    const worst = run.reduce((a, b) => (Math.abs(b.drift) > Math.abs(a.drift) ? b : a));
    const losing = worst.drift < 0;
    const mag = Math.abs(worst.drift);
    const s: Severity = mag >= 50 ? "WARN" : "WATCH";

    return {
      id: `fi-${i + 1}`,
      type: "FLOW_IMBALANCE" as const,
      severity: s,
      confidence: "LOW" as const,
      from: run[0].t,
      to: run[run.length - 1].t + MINUTE,
      durationMin: run.length,
      depthFrom: run[0].m.holeDepth,
      depthTo: run[run.length - 1].m.holeDepth,
      headline: `Return flow ${losing ? "down" : "up"} ${fmt(mag)}% against its own baseline for ${run.length} min at ${fmt(worst.m.holeDepth ?? 0, 0)} ft, with flow in steady - ${losing ? "possible losses" : "possible gain"}.`,
      evidence: {
        driftPct: fmt(worst.drift),
        baselineMfop: fmt(worst.baseline),
        observedMfop: fmt(worst.mfop),
        flowInGpm: fmt(worst.m.stats.MFIA?.mean ?? 0, 0),
        sustainedMinutes: run.length,
      },
      caveat:
        "The MFOP channel in this export is not the percentage-of-flow-in the glossary describes (median 20, max 69 with pumps running), so only relative drift is used and the absolute value means nothing here. Confirm the sensor scaling before treating this as a losses or kick indicator.",
    };
  });
}

/* ------------------------------------------------------------------ */
/* 5. OFFSET ENVELOPE EXCEEDANCE                                       */
/* ------------------------------------------------------------------ */
/**
 * The offset table records the highest value each parameter reached on the
 * reference well while drilling a given hole section - a rough "nothing here has
 * ever gone past this" ceiling. Exceeding it is not automatically a fault, but it
 * is worth knowing that today's well is operating outside anything the field has
 * seen before in the same hole size.
 *
 * The hole size used for the join comes from the DDR activity timeline, not from
 * guessing at depth: the same depth belongs to different sections on different
 * wells, and the DDR states it directly.
 */
export function detectEnvelopeExceedance(
  minutes: MinuteRecord[],
  offsets: OffsetEnvelope[],
  minMinutes = 5,
): Anomaly[] {
  const byHoleSize = new Map<string, OffsetEnvelope>();
  for (const o of offsets) if (o.holeSize) byHoleSize.set(o.holeSize, o);

  const checks: { ch: ChannelCode; label: string; unit: string; limit: (o: OffsetEnvelope) => number }[] = [
    { ch: "SPP", label: "Standpipe pressure", unit: "psi", limit: (o) => o.maxSpp },
    { ch: "MFIA", label: "Flow in", unit: "gpm", limit: (o) => o.maxFlowRate },
    { ch: "TORQUE", label: "Rotary torque", unit: "ft-lb", limit: (o) => o.maxTorque },
    { ch: "WOB", label: "Weight on bit", unit: "klb", limit: (o) => o.maxWob },
  ];

  const out: Anomaly[] = [];

  for (const chk of checks) {
    const flagged: { t: number; m: MinuteRecord; value: number; limit: number; section: string }[] = [];

    for (const m of minutes) {
      if (m.state !== "DRILLING" && m.state !== "SLIDING") continue;
      if (!m.holeSize) continue;
      const o = byHoleSize.get(m.holeSize);
      if (!o) continue;
      const limit = chk.limit(o);
      if (!limit) continue;

      // p90 rather than max: one spiky sample should not raise an exceedance, but a
      // channel genuinely sitting above the ceiling will have a high p90.
      const v = m.stats[chk.ch]?.p90;
      if (v === undefined || v <= limit) continue;
      flagged.push({ t: m.t, m, value: v, limit, section: o.section });
    }

    groupRuns(flagged, minMinutes).forEach((run, i) => {
      const worst = run.reduce((a, b) => (b.value > a.value ? b : a));
      const overPct = ((worst.value - worst.limit) / worst.limit) * 100;
      const s: Severity = overPct >= 25 ? "WARN" : "WATCH";

      out.push({
        id: `env-${chk.ch.toLowerCase()}-${i + 1}`,
        type: "ENVELOPE_EXCEEDANCE",
        severity: s,
        confidence: "HIGH",
        from: run[0].t,
        to: run[run.length - 1].t + MINUTE,
        durationMin: run.length,
        depthFrom: run[0].m.holeDepth,
        depthTo: run[run.length - 1].m.holeDepth,
        headline: `${chk.label} ran ${fmt(overPct)}% above the offset-well ceiling for ${run.length} min - ${fmt(worst.value, 0)} ${chk.unit} against a historical max of ${fmt(worst.limit, 0)}.`,
        evidence: {
          channel: chk.ch,
          peakValue: fmt(worst.value, 1),
          offsetCeiling: worst.limit,
          overByPct: fmt(overPct),
          holeSection: worst.section,
          sustainedMinutes: run.length,
        },
        caveat:
          "The offset ceiling is one historical well's maximum, not an engineered operating limit. Exceeding it means today is outside prior field experience for this hole size - it is a prompt to check the plan, not a fault on its own.",
      });
    });
  }

  return out;
}

/** Run every detector and return one time-ordered list. */
export function detectAll(
  minutes: MinuteRecord[],
  offsets: OffsetEnvelope[],
  cfg = DEFAULT_CONFIG,
): Anomaly[] {
  return [
    ...detectStickSlip(minutes, cfg),
    ...detectWashout(minutes, cfg),
    ...detectOverpull(minutes, cfg),
    ...detectFlowImbalance(minutes, cfg),
    ...detectEnvelopeExceedance(minutes, offsets),
  ].sort((a, b) => a.from - b.from);
}
