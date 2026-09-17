import { db } from "./data";
import type { Anomaly, QualityFinding, FeedGap } from "./types";
import type { StateSpan, AgreementRow } from "../../etl/state";
import type { WellSummary, SeriesPoint } from "../../etl/aggregate";

/**
 * Builds the payload the dashboard actually needs, server-side.
 *
 * The full minute table is ~10 MB. Shipping it to a browser to render a 900-pixel
 * chart would be the same mistake as averaging the variance away, in the other
 * direction. So the page sends:
 *
 *  - pre-aggregated 5-minute series that already carry min/max/sd, and
 *  - a compact per-minute "cockpit" array for the replay readout,
 *
 * encoded as positional tuples rather than objects. Repeating eleven key names
 * across 7,330 rows costs roughly four times the payload of the numbers themselves;
 * at one well that is merely wasteful, and at fifty rigs it is the difference
 * between a dashboard that opens and one that does not.
 */

export type Cockpit = [
  t: number,
  state: string,
  holeDepth: number | null,
  bitDepth: number | null,
  rop: number | null,
  wob: number | null,
  torque: number | null,
  rpm: number | null,
  spp: number | null,
  flowIn: number | null,
  hookload: number | null,
  torqueDispersion: number | null,
];

export interface ClientPayload {
  meta: { well: string; rig: string; field: string; from: number; to: number; rawRows: number; minutes: number };
  summary: WellSummary;
  cockpit: Cockpit[];
  series: Record<string, SeriesPoint[]>;
  spans: { state: string; from: number; to: number }[];
  stateMinutes: Record<string, number>;
  anomalies: Anomaly[];
  quality: QualityFinding[];
  assumptions: string[];
  gaps: FeedGap[];
  agreement: { overall: number; scoredMinutes: number; rows: AgreementRow[] };
  ropWob: { wob: number; rop: number; rpm: number; depth: number | null }[];
  offsetWob: number | null;
  envelope: {
    section: string;
    holeSize: string | null;
    drilledMinutes: number;
    comparison: Record<string, { actual: number; limit: number; overPct: number; exceeded: boolean } | null>;
  }[];
}

const r = (v: number | null | undefined, d = 1): number | null =>
  v === null || v === undefined ? null : +v.toFixed(d);

export function buildPayload(): ClientPayload {
  const { manifest, minutes, spans, anomalies, summary, series, ropWob, quality, agreement, offsets } = db();

  const cockpit: Cockpit[] = minutes.map((m) => [
    m.t,
    m.state,
    r(m.holeDepth, 1),
    r(m.bitDepth, 1),
    r(m.ropCalc, 1),
    r(m.stats.WOB?.mean, 1),
    r(m.torqueMedian ?? m.stats.TORQUE?.mean, 0),
    r(m.stats.RPM?.mean, 0),
    r(m.stats.SPP?.mean, 0),
    r(m.stats.MFIA?.mean, 0),
    r(m.stats.HKLA?.mean, 1),
    r(m.torqueNMad, 2),
  ]);

  const stateMinutes: Record<string, number> = {};
  for (const m of minutes) stateMinutes[m.state] = (stateMinutes[m.state] ?? 0) + 1;

  // The scatter is capped so the chart stays responsive; taking every Nth drilling
  // minute preserves the shape of the cloud without shipping thousands of points.
  const STRIDE = Math.max(1, Math.ceil(ropWob.length / 2500));

  const bySize = new Map<string, { rop: number; flow: number; wob: number; spp: number; torque: number; hookload: number; minutes: number }>();
  for (const m of minutes) {
    if (m.state !== "DRILLING" && m.state !== "SLIDING") continue;
    if (!m.holeSize) continue;
    let e = bySize.get(m.holeSize);
    if (!e) bySize.set(m.holeSize, (e = { rop: 0, flow: 0, wob: 0, spp: 0, torque: 0, hookload: 0, minutes: 0 }));
    e.minutes++;
    e.rop = Math.max(e.rop, m.ropCalc ?? 0);
    e.flow = Math.max(e.flow, m.stats.MFIA?.p90 ?? 0);
    e.wob = Math.max(e.wob, m.stats.WOB?.p90 ?? 0);
    e.spp = Math.max(e.spp, m.stats.SPP?.p90 ?? 0);
    e.torque = Math.max(e.torque, m.stats.TORQUE?.p90 ?? 0);
    e.hookload = Math.max(e.hookload, m.stats.HKLA?.p90 ?? 0);
  }

  const cmp = (actual: number | undefined, limit: number) =>
    actual === undefined || !limit
      ? null
      : { actual: +actual.toFixed(1), limit, overPct: +(((actual - limit) / limit) * 100).toFixed(1), exceeded: actual > limit };

  const envelope = offsets
    .map((o) => {
      const live = o.holeSize ? bySize.get(o.holeSize) : undefined;
      return {
        section: o.section,
        holeSize: o.holeSize,
        drilledMinutes: live?.minutes ?? 0,
        comparison: {
          rop: cmp(live?.rop, o.maxRop),
          flowRate: cmp(live?.flow, o.maxFlowRate),
          wob: cmp(live?.wob, o.maxWob),
          spp: cmp(live?.spp, o.maxSpp),
          torque: cmp(live?.torque, o.maxTorque),
          puWeight: cmp(live?.hookload, o.maxPuWeight),
        },
      };
    })
    // Only sections this well actually drilled during the telemetry window.
    .filter((e) => e.drilledMinutes > 0);

  // The WOB ceiling for whichever section the well spent most of its time in - used
  // as the reference line on the ROP/WOB scatter.
  const dominant = [...bySize.entries()].sort((a, b) => b[1].minutes - a[1].minutes)[0]?.[0];
  const offsetWob = offsets.find((o) => o.holeSize === dominant)?.maxWob ?? null;

  return {
    meta: {
      well: manifest.well,
      rig: manifest.rig,
      field: manifest.field,
      from: manifest.telemetry.from,
      to: manifest.telemetry.to,
      rawRows: manifest.telemetry.rawRows,
      minutes: manifest.telemetry.minutes,
    },
    summary,
    cockpit,
    series,
    spans: spans.map((s: StateSpan) => ({ state: s.state, from: s.from, to: s.to })),
    stateMinutes,
    anomalies,
    quality,
    assumptions: manifest.assumptions,
    gaps: manifest.telemetry.gaps,
    agreement,
    ropWob: ropWob.filter((_, i) => i % STRIDE === 0).map((p) => ({ wob: p.wob, rop: p.rop, rpm: p.rpm, depth: p.depth })),
    offsetWob,
    envelope,
  };
}
