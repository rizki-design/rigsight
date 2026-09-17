import { db, ok } from "@/lib/data";

/**
 * GET /api/quality
 *
 * The data-quality report as a first-class endpoint rather than a paragraph in a
 * README. Each finding carries the row count it affects and the action taken.
 * On a real rig feed this is what decides whether a number can be trusted, so it
 * ships next to the numbers.
 */
export function GET() {
  const { quality, manifest } = db();
  return ok({
    well: manifest.well,
    rig: manifest.rig,
    rawRows: manifest.telemetry.rawRows,
    malformedRows: manifest.telemetry.malformedRows,
    findings: quality,
    assumptions: manifest.assumptions,
    gaps: manifest.telemetry.gaps,
  });
}
