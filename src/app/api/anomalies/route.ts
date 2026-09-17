import { db, ok, badRequest, parseTime } from "@/lib/data";
import type { AnomalyType, Severity } from "@/lib/types";

const TYPES: AnomalyType[] = ["STICK_SLIP", "WASHOUT", "FLOW_IMBALANCE", "OVERPULL", "ENVELOPE_EXCEEDANCE"];
const RANK: Record<Severity, number> = { WATCH: 1, WARN: 2, ALARM: 3 };

/**
 * GET /api/anomalies?type=&minSeverity=&from=&to=
 *
 * Every event carries the evidence it fired on, a confidence level and, where the
 * underlying data limits the call, an explicit caveat. A flag a driller cannot
 * interrogate is a flag they will learn to ignore.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const { anomalies } = db();

  const typeParam = url.searchParams.get("type");
  if (typeParam && !TYPES.includes(typeParam.toUpperCase() as AnomalyType)) {
    return badRequest("unknown type: " + typeParam, { available: TYPES });
  }

  const minSev = (url.searchParams.get("minSeverity") ?? "WATCH").toUpperCase() as Severity;
  if (!(minSev in RANK)) return badRequest("minSeverity must be WATCH, WARN or ALARM");

  const from = parseTime(url.searchParams.get("from"));
  const to = parseTime(url.searchParams.get("to"));

  const rows = anomalies.filter((a) => {
    if (typeParam && a.type !== typeParam.toUpperCase()) return false;
    if (RANK[a.severity] < RANK[minSev]) return false;
    if (from !== null && a.to < from) return false;
    if (to !== null && a.from > to) return false;
    return true;
  });

  const counts: Record<string, number> = {};
  for (const a of rows) counts[a.type] = (counts[a.type] ?? 0) + 1;

  return ok({
    count: rows.length,
    countsByType: counts,
    anomalies: rows,
    detectors: {
      STICK_SLIP: "Robust dispersion (normalised MAD) of the cleaned torque channel, gated on bit-on-bottom, 40+ RPM, steady RPM and steady WOB. MEDIUM confidence everywhere: ~1.7 s sampling against a 1-10 s stick-slip period is aliased, so this ranks severity rather than measuring it.",
      WASHOUT: "Standpipe pressure falling 8%+ below its trailing 20-minute median while flow in holds within 3%, sustained 5 minutes. Persistence is what separates a washout, which does not recover, from a pump adjustment, which does.",
      OVERPULL: "Hookload peak exceeding the trailing normal pick-up weight by 10+ klb during a trip out. Scored across the whole trip episode rather than only on minutes classified as tripping, because a badly stuck string stops moving - which is exactly when it matters most.",
      FLOW_IMBALANCE: "Relative drift of the flow-out channel against its own baseline while flow in holds steady. LOW confidence: in this export MFOP is not the percentage-of-flow-in the glossary describes, so only relative movement is usable.",
      ENVELOPE_EXCEEDANCE: "Channel p90 above the offset well's historical maximum for the same hole size, sustained 5 minutes. The hole size comes from the DDR activity timeline rather than being guessed from depth.",
    },
  });
}
