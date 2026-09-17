import { db, ok } from "@/lib/data";

/** Liveness plus a fingerprint of the loaded dataset, so a caller can tell which ETL run they are talking to. */
export function GET() {
  const { manifest } = db();
  return ok({
    status: "ok",
    dataset: {
      well: manifest.well,
      rig: manifest.rig,
      generatedAt: manifest.generatedAt,
      from: manifest.telemetry.from,
      to: manifest.telemetry.to,
      minutes: manifest.telemetry.minutes,
    },
  });
}
