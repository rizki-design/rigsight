import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MinuteRecord,
  Anomaly,
  DdrRow,
  OffsetEnvelope,
  QualityFinding,
  Manifest,
} from "./types";
import type { StateSpan, AgreementRow } from "../../etl/state";
import type { IntervalAggregate, WellSummary, SeriesPoint } from "../../etl/aggregate";

/**
 * Loads the ETL artefacts once per process and keeps them in module scope.
 *
 * Deliberately not a database. At one well and 7,330 minutes the whole dataset is a
 * few megabytes, and an in-process read keeps the repo clonable and runnable with
 * two commands. The boundary is drawn so that swapping this for a real time-series
 * store (see the scaling notes in the README) means rewriting this file and nothing
 * else - every route handler goes through these accessors.
 */

const DIR = join(process.cwd(), "data", "processed");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as T;
}

let cache: {
  manifest: Manifest;
  minutes: MinuteRecord[];
  spans: StateSpan[];
  anomalies: Anomaly[];
  summary: WellSummary;
  intervals: { hourly: IntervalAggregate[]; fourHourly: IntervalAggregate[]; daily: IntervalAggregate[] };
  series: Record<string, SeriesPoint[]>;
  ropWob: { t: number; wob: number; rop: number; rpm: number; torque: number | null; depth: number | null; state: string }[];
  ddr: DdrRow[];
  offsets: OffsetEnvelope[];
  quality: QualityFinding[];
  agreement: { overall: number; scoredMinutes: number; rows: AgreementRow[] };
} | null = null;

export function db() {
  if (!cache) {
    cache = {
      manifest: load("manifest.json"),
      minutes: load("minutes.json"),
      spans: load("spans.json"),
      anomalies: load("anomalies.json"),
      summary: load("summary.json"),
      intervals: load("intervals.json"),
      series: load("series.json"),
      ropWob: load("rop-wob.json"),
      ddr: load("ddr.json"),
      offsets: load("offsets.json"),
      quality: load("quality.json"),
      agreement: load("agreement.json"),
    };
  }
  return cache;
}

/** Parse a `from`/`to` query param: epoch ms, or an ISO date string. */
export function parseTime(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function windowFilter<T extends { t: number }>(rows: T[], from: number | null, to: number | null): T[] {
  if (from === null && to === null) return rows;
  return rows.filter((r) => (from === null || r.t >= from) && (to === null || r.t <= to));
}

/** Consistent error envelope, so a bad query never returns a 200 with junk in it. */
export function badRequest(message: string, detail?: unknown) {
  return Response.json({ error: "bad_request", message, detail }, { status: 400 });
}

export function ok(body: unknown, extra?: ResponseInit) {
  return Response.json(body, {
    ...extra,
    headers: {
      // The dataset is a fixed historical export, so responses are cacheable. A live
      // feed would drop this to a few seconds.
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      ...(extra?.headers ?? {}),
    },
  });
}
