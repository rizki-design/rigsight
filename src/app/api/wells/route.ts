import { db, ok } from "@/lib/data";

/**
 * Dataset metadata: which well the telemetry belongs to, how much of the window is
 * actually covered, and every assumption the pipeline made. Returned as data rather
 * than buried in a README so the caveats travel with the numbers.
 */
export function GET() {
  const { manifest, summary, agreement } = db();
  return ok({
    well: manifest.well,
    rig: manifest.rig,
    field: manifest.field,
    coverage: {
      from: manifest.telemetry.from,
      to: manifest.telemetry.to,
      measuredMinutes: manifest.telemetry.coveredMinutes,
      missingMinutes: manifest.telemetry.missingMinutes,
      rowsPerMinute: manifest.telemetry.rowsPerMinute,
      gaps: manifest.telemetry.gaps,
    },
    summary,
    stateDetectionAgreement: {
      overallPct: agreement.overall,
      scoredMinutes: agreement.scoredMinutes,
      byActivity: agreement.rows,
      note: "Agreement between the sensor-derived state and the driller's own activity codes. Not a target to maximise: a DDR line reading 'TIH, 8 hrs' is a coarse envelope that also contains the circulating and connection breaks inside that trip, which the sensors resolve and the paperwork rounds off.",
    },
    assumptions: manifest.assumptions,
    ddr: manifest.ddr,
  });
}
