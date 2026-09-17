import { db, ok, badRequest } from "@/lib/data";

/**
 * GET /api/aggregates?interval=1h|4h|1d
 *
 * Progress and rate per interval. See etl/aggregate.ts for why three different ROP
 * numbers are returned rather than one: the vendor ROP channel never reaches zero in
 * this export, so averaging it is not a meaningful drilling rate.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const interval = (url.searchParams.get("interval") ?? "1h").toLowerCase();
  const { intervals, summary } = db();

  const pick = interval === "1h" ? intervals.hourly
    : interval === "4h" ? intervals.fourHourly
    : interval === "1d" ? intervals.daily
    : null;

  if (!pick) return badRequest("interval must be one of 1h, 4h, 1d");

  return ok({
    interval,
    summary,
    intervals: pick,
    definitions: {
      footage: "New hole made in the interval, from the measured change in hole depth.",
      ropOnBottom: "footage / hours classified as making hole. The drilling performance number - how fast the bit cuts.",
      ropOverall: "footage / all measured hours, including trips, connections and repairs. The delivery number - what actually predicts when the well finishes.",
      ropChannelMean: "Mean of the vendor ROP channel over the same window. Published only so the discrepancy against ropOnBottom is visible: this channel never reads zero, so it mixes real drilling rate with a floor value from hours when no hole was being made.",
      measuredMinutes: "Minutes with telemetry. Feed gaps are excluded from every rate denominator above.",
    },
  });
}
