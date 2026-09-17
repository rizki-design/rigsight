import { db, ok, badRequest } from "@/lib/data";

/**
 * GET /api/ddr?well=&activity=&nptOnly=&limit=&offset=
 *
 * The structured report log, filterable. `fullComment=1` returns the whole narrative;
 * by default the comment is truncated, since several run past 1,900 characters.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const { ddr } = db();

  const well = url.searchParams.get("well");
  const activity = url.searchParams.get("activity");
  const nptOnly = url.searchParams.get("nptOnly") === "1";
  const full = url.searchParams.get("fullComment") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 600);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(offset) || offset < 0) return badRequest("limit/offset must be non-negative numbers");

  let rows = ddr;
  if (well) rows = rows.filter((r) => r.well === well);
  if (activity) rows = rows.filter((r) => r.activity === activity.toUpperCase());
  if (nptOnly) rows = rows.filter((r) => r.nptHrs > 0);

  const page = rows.slice(offset, offset + limit).map((r) => ({
    ...r,
    comment: full ? r.comment : r.comment.slice(0, 400) + (r.comment.length > 400 ? "..." : ""),
  }));

  return ok({
    total: rows.length,
    offset,
    limit,
    rows: page,
    totals: {
      durationHrs: +rows.reduce((a, r) => a + r.durationHrs, 0).toFixed(2),
      nptHrs: +rows.reduce((a, r) => a + r.nptHrs, 0).toFixed(2),
      nptLines: rows.filter((r) => r.nptHrs > 0).length,
    },
  });
}
