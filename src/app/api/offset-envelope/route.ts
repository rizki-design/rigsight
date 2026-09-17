import { db, ok } from "@/lib/data";

/**
 * GET /api/offset-envelope
 *
 * The historical operating ceilings from the offset well, joined to what this well
 * actually did in the same hole size, so "are we outside prior field experience" is
 * answerable directly.
 */
export function GET() {
  const { offsets, minutes, anomalies } = db();

  type Live = { rop: number; flow: number; wob: number; spp: number; torque: number; hookload: number; minutes: number };
  const bySize = new Map<string, Live>();

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

  const rows = offsets.map((o) => {
    const live = o.holeSize ? bySize.get(o.holeSize) : undefined;
    return {
      section: o.section,
      holeSize: o.holeSize,
      offsetWell: o.well,
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
  });

  return ok({
    envelope: rows,
    exceedanceEvents: anomalies.filter((a) => a.type === "ENVELOPE_EXCEEDANCE"),
    notes: [
      "Hole size is taken from the DDR activity timeline, not inferred from depth - the same depth sits in different sections on different wells.",
      "Telemetry torque is compared as ft-lb, not the kft-lb printed in the unit header row. The header is mislabelled: the channel's range matches the offset ceiling for the same section, and taken literally every reading would be 1000x over.",
      "These are one historical well's maxima, not engineered limits. Exceeding one means today is outside prior field experience for this hole size - a prompt to check the plan, not a fault.",
    ],
  });
}
