import { db, ok, parseTime } from "@/lib/data";

/**
 * GET /api/state?from=&to=&at=
 *
 * The operational state timeline, plus the "what is the rig doing right now" answer
 * that drives the dashboard status panel. With `at`, returns the state at a single
 * instant; otherwise the spans across the window.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const { spans, minutes, manifest, agreement } = db();

  const at = parseTime(url.searchParams.get("at"));
  if (at !== null) {
    const span = spans.find((s) => at >= s.from && at < s.to) ?? null;
    const minute = minutes.find((m) => m.t <= at && at < m.t + 60_000) ?? null;
    return ok({ at, span, minute });
  }

  const from = parseTime(url.searchParams.get("from"));
  const to = parseTime(url.searchParams.get("to"));
  const rows = spans.filter((s) => (from === null || s.to > from) && (to === null || s.from < to));

  const totals: Record<string, number> = {};
  for (const s of rows) totals[s.state] = (totals[s.state] ?? 0) + s.minutes;

  return ok({
    well: manifest.well,
    rig: manifest.rig,
    spans: rows,
    totalMinutesByState: totals,
    agreementWithDdrPct: agreement.overall,
    method: "State is derived from change in hole depth, bit movement and block position - not from the ROP channel, which never reaches zero in this export and cannot separate drilling from tripping. Hole advance is judged over a centred 7-minute window and trips over a 15-minute window, because both depth channels update in quantised steps.",
  });
}
