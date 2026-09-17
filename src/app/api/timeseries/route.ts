import { db, ok, badRequest, parseTime } from "@/lib/data";
import type { ChannelCode, MinuteRecord } from "@/lib/types";

const CHANNEL_KEYS: Record<string, keyof MinuteRecord["stats"] | "torqueDispersion" | "ropCalc"> = {
  DBTM: "DBTM", DMEA: "DMEA", BPOS: "BPOS", ROP: "ROP", HKLA: "HKLA",
  WOB: "WOB", TORQUE: "TORQUE", RPM: "RPM", SPP: "SPP", MFOP: "MFOP", MFIA: "MFIA",
  TORQUE_DISPERSION: "torqueDispersion",
  ROP_CALC: "ropCalc",
};

/**
 * GET /api/timeseries
 *   ?channels=TORQUE,WOB        required - comma separated
 *   &from=&to=                  epoch ms or ISO, optional
 *   &resolution=1|5|15|60       minutes per point, default 5
 *
 * Every point carries mean, min, max and standard deviation rather than a single
 * averaged value. That is the whole point of this endpoint: downsampling a torque
 * channel to its mean destroys the stick-slip signal, which lives entirely in the
 * short-timescale spread. Here the spread is part of the payload at every
 * resolution, so a caller can plot the envelope and a detector can still work
 * against aggregated data.
 *
 * TORQUE_DISPERSION returns the robust dispersion index used by the stick-slip
 * detector (normalised MAD over cleaned samples), which is the resampling-safe
 * version of "how hard is torque swinging".
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const { minutes, manifest } = db();

  const raw = url.searchParams.get("channels");
  if (!raw) return badRequest("channels is required, e.g. ?channels=TORQUE,WOB", { available: Object.keys(CHANNEL_KEYS) });

  const channels = raw.split(",").map((c) => c.trim().toUpperCase());
  const unknown = channels.filter((c) => !(c in CHANNEL_KEYS));
  if (unknown.length) return badRequest("unknown channel(s): " + unknown.join(", "), { available: Object.keys(CHANNEL_KEYS) });

  const from = parseTime(url.searchParams.get("from"));
  const to = parseTime(url.searchParams.get("to"));
  const res = Number(url.searchParams.get("resolution") ?? 5);
  if (!Number.isFinite(res) || res < 1 || res > 240) return badRequest("resolution must be between 1 and 240 minutes");

  const rows = minutes.filter((m) => (from === null || m.t >= from) && (to === null || m.t <= to));
  if (!rows.length) return ok({ from, to, resolution: res, channels: {}, points: 0 });

  const bucketMs = res * 60_000;
  type Pt = { t: number; mean: number | null; min: number | null; max: number | null; sd: number | null; n: number };
  const out: Record<string, Pt[]> = {};

  for (const ch of channels) {
    const key = CHANNEL_KEYS[ch];
    const series: Pt[] = [];

    let i = 0;
    while (i < rows.length) {
      const t0 = Math.floor(rows[i].t / bucketMs) * bucketMs;
      const vals: { mean: number; min: number; max: number; sd: number }[] = [];
      let sawGap = false;

      let j = i;
      while (j < rows.length && rows[j].t < t0 + bucketMs) {
        if (j > i && rows[j].t - rows[j - 1].t > 60_000) sawGap = true;

        if (key === "torqueDispersion") {
          const v = rows[j].torqueNMad;
          if (v !== null) vals.push({ mean: v, min: v, max: v, sd: 0 });
        } else if (key === "ropCalc") {
          const v = rows[j].ropCalc;
          if (v !== null) vals.push({ mean: v, min: v, max: v, sd: 0 });
        } else {
          const s = rows[j].stats[key as ChannelCode];
          if (s) vals.push({ mean: s.mean, min: s.min, max: s.max, sd: s.sd });
        }
        j++;
      }

      if (vals.length) {
        series.push({
          t: t0,
          mean: +(vals.reduce((a, v) => a + v.mean, 0) / vals.length).toFixed(3),
          min: +Math.min(...vals.map((v) => v.min)).toFixed(3),
          max: +Math.max(...vals.map((v) => v.max)).toFixed(3),
          // Root mean square of the per-minute spreads: keeps the typical
          // within-minute variation instead of averaging it to nothing.
          sd: +Math.sqrt(vals.reduce((a, v) => a + v.sd * v.sd, 0) / vals.length).toFixed(3),
          n: vals.length,
        });
      }
      // A null point marks a real hole in the feed, so a client draws a break in the
      // line instead of joining across time nobody measured.
      if (sawGap) series.push({ t: t0 + bucketMs - 1, mean: null, min: null, max: null, sd: null, n: 0 });
      i = j;
    }

    out[ch] = series;
  }

  return ok({
    well: manifest.well,
    rig: manifest.rig,
    from: rows[0].t,
    to: rows[rows.length - 1].t,
    resolutionMinutes: res,
    channels: out,
    note: "Each point carries mean/min/max/sd. Standard deviation is aggregated as a root-mean-square of the per-minute spreads so variance survives downsampling - averaging it away would erase the stick-slip signal. Null points mark feed gaps and should break the line.",
  });
}
