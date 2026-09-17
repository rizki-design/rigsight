/**
 * ETL entry point:  raw CSV  ->  cleaned, analysed JSON artefacts.
 *
 * Runs once (`npm run etl`) and writes everything the API serves into
 * data/processed/. Those artefacts are committed, so a reviewer can clone the repo
 * and start the app without a build step - and, more importantly, can diff the
 * output of a cleaning change in a pull request instead of taking it on trust.
 *
 * Keeping this out of the request path is also the shape the production version
 * wants: parsing 250k rows per rig on every API call does not survive 50 rigs, but
 * a scheduled job writing to a time-series store does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTelemetry } from "./parse-telemetry.js";
import { parseDdr, parseOffset } from "./parse-ddr.js";
import { applyStates, applyHoleSize, toSpans, agreementWithDdr, DEFAULT_THRESHOLDS } from "./state.js";
import { detectAll, DEFAULT_CONFIG } from "./anomalies.js";
import { computeIntervals, summarise, buildSeries } from "./aggregate.js";
import type { Manifest } from "../src/lib/types.js";

const ROOT = process.cwd();
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "data", "processed");

const MINUTE = 60_000;
const HOUR = 3_600_000;

function write(name: string, data: unknown) {
  const json = JSON.stringify(data);
  writeFileSync(join(OUT, name), json);
  const kb = (Buffer.byteLength(json) / 1024).toFixed(0);
  console.log(`  ${name.padEnd(26)} ${kb.padStart(7)} KB`);
}

function main() {
  const t0 = Date.now();
  mkdirSync(OUT, { recursive: true });

  console.log("\nRigSight ETL");
  console.log("============");

  // ---- parse ---------------------------------------------------------------
  console.log("\n[1/5] Parsing raw files");
  const tel = parseTelemetry(join(RAW, "realtime_rig_telemetry.csv"));
  const ddr = parseDdr(join(RAW, "daily_drilling_reports.csv"));
  const offsets = parseOffset(join(RAW, "offset_wells_master.csv"));
  console.log(`  telemetry  ${tel.meta.rawRows.toLocaleString()} rows -> ${tel.minutes.length.toLocaleString()} minutes`);
  console.log(`  ddr        ${ddr.length} activity rows`);
  console.log(`  offsets    ${offsets.length} hole sections`);

  // ---- identify the well the telemetry belongs to --------------------------
  // The telemetry file carries no well or rig identifier - only a timestamp and 11
  // channels. It is matched to a well by overlapping its time window against the
  // DDR, then cross-checked on depth: the feed opens at 794.79 ft on 9 Sep and ends
  // at 4062.19 ft on 14 Sep, and the DDR for SEBL_002 reports exactly 795 ft and
  // 4062 ft at those times. That is a strong enough match to join the two sources.
  const overlap = ddr.filter((d) => d.end > tel.meta.from && d.start < tel.meta.to);
  const wellCounts = new Map<string, number>();
  for (const d of overlap) wellCounts.set(d.well, (wellCounts.get(d.well) ?? 0) + 1);
  const well = [...wellCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "UNKNOWN";
  const rig = overlap.find((d) => d.well === well)?.rig ?? "UNKNOWN";
  const field = overlap.find((d) => d.well === well)?.field ?? "UNKNOWN";
  console.log(`  matched telemetry -> ${well} / ${rig} (${overlap.length} overlapping DDR rows)`);

  const wellDdr = ddr.filter((d) => d.well === well);

  // ---- derive --------------------------------------------------------------
  console.log("\n[2/5] Classifying operational state");
  applyHoleSize(tel.minutes, wellDdr);
  applyStates(tel.minutes, tel.gaps, DEFAULT_THRESHOLDS);
  const spans = toSpans(tel.minutes);
  const agreement = agreementWithDdr(tel.minutes, wellDdr);
  console.log(`  ${spans.length} state spans`);
  console.log(`  agreement with DDR activity codes: ${agreement.overall}% over ${agreement.scoredMinutes.toLocaleString()} scored minutes`);

  console.log("\n[3/5] Running anomaly detectors");
  const anomalies = detectAll(tel.minutes, offsets, DEFAULT_CONFIG);
  const byType = new Map<string, number>();
  for (const a of anomalies) byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
  for (const [t, n] of byType) console.log(`  ${t.padEnd(22)} ${n}`);
  if (!anomalies.length) console.log("  (none)");

  console.log("\n[4/5] Aggregating");
  const summary = summarise(tel.minutes, wellDdr);
  const hourly = computeIntervals(tel.minutes, HOUR);
  const fourHourly = computeIntervals(tel.minutes, 4 * HOUR);
  const daily = computeIntervals(tel.minutes, 24 * HOUR);
  console.log(`  ${summary.totalFootage.toLocaleString()} ft drilled over ${summary.measuredHours} measured hours`);
  console.log(`  ROP on-bottom ${summary.ropOnBottom} ft/hr | overall ${summary.ropOverall} ft/hr | vendor channel mean ${summary.ropChannelMean} ft/hr`);

  // ---- chart series --------------------------------------------------------
  // Pre-built at two resolutions so the dashboard never ships 7,330 points to the
  // browser for a 900px-wide chart, while keeping the min/max envelope intact.
  const series = {
    depth: buildSeries(tel.minutes, (m) => (m.stats.DMEA ? { mean: m.stats.DMEA.mean, min: m.stats.DMEA.min, max: m.stats.DMEA.max, sd: m.stats.DMEA.sd } : null), 5),
    bitDepth: buildSeries(tel.minutes, (m) => (m.stats.DBTM ? { mean: m.stats.DBTM.mean, min: m.stats.DBTM.min, max: m.stats.DBTM.max, sd: m.stats.DBTM.sd } : null), 5),
    rop: buildSeries(tel.minutes, (m) => ({ mean: m.ropCalc ?? 0, min: m.ropCalc ?? 0, max: m.ropCalc ?? 0, sd: 0 }), 5),
    wob: buildSeries(tel.minutes, (m) => (m.stats.WOB ? { mean: m.stats.WOB.mean, min: m.stats.WOB.min, max: m.stats.WOB.max, sd: m.stats.WOB.sd } : null), 5),
    torque: buildSeries(tel.minutes, (m) => (m.stats.TORQUE ? { mean: m.torqueMedian ?? m.stats.TORQUE.mean, min: m.stats.TORQUE.min, max: m.stats.TORQUE.max, sd: m.stats.TORQUE.sd } : null), 5),
    rpm: buildSeries(tel.minutes, (m) => (m.stats.RPM ? { mean: m.stats.RPM.mean, min: m.stats.RPM.min, max: m.stats.RPM.max, sd: m.stats.RPM.sd } : null), 5),
    spp: buildSeries(tel.minutes, (m) => (m.stats.SPP ? { mean: m.stats.SPP.mean, min: m.stats.SPP.min, max: m.stats.SPP.max, sd: m.stats.SPP.sd } : null), 5),
    hookload: buildSeries(tel.minutes, (m) => (m.stats.HKLA ? { mean: m.stats.HKLA.mean, min: m.stats.HKLA.min, max: m.stats.HKLA.max, sd: m.stats.HKLA.sd } : null), 5),
    flowIn: buildSeries(tel.minutes, (m) => (m.stats.MFIA ? { mean: m.stats.MFIA.mean, min: m.stats.MFIA.min, max: m.stats.MFIA.max, sd: m.stats.MFIA.sd } : null), 5),
    blockPos: buildSeries(tel.minutes, (m) => (m.stats.BPOS ? { mean: m.stats.BPOS.mean, min: m.stats.BPOS.min, max: m.stats.BPOS.max, sd: m.stats.BPOS.sd } : null), 5),
    torqueDispersion: buildSeries(tel.minutes, (m) => (m.torqueNMad !== null ? { mean: m.torqueNMad, min: m.torqueNMad, max: m.torqueNMad, sd: 0 } : null), 5),
  };

  // ROP vs WOB scatter, restricted to minutes actually making hole. Plotting all
  // 7,330 minutes buries the drilling relationship under thousands of tripping
  // points sitting at WOB 0.
  const ropWob = tel.minutes
    .filter((m) => (m.state === "DRILLING" || m.state === "SLIDING") && m.stats.WOB && m.ropCalc !== null)
    .map((m) => ({
      t: m.t,
      wob: +m.stats.WOB!.mean.toFixed(2),
      rop: +m.ropCalc!.toFixed(1),
      rpm: +(m.stats.RPM?.mean ?? 0).toFixed(0),
      torque: m.torqueMedian !== null ? +m.torqueMedian.toFixed(0) : null,
      depth: m.holeDepth !== null ? +m.holeDepth.toFixed(0) : null,
      state: m.state,
    }));

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    well,
    rig,
    field,
    telemetry: {
      rawRows: tel.meta.rawRows,
      malformedRows: tel.meta.malformedRows,
      from: tel.meta.from,
      to: tel.meta.to,
      minutes: tel.minutes.length,
      coveredMinutes: tel.meta.coveredMinutes,
      missingMinutes: tel.meta.missingMinutes,
      rowsPerMinute: tel.meta.rowsPerMinute,
      gaps: tel.gaps,
    },
    ddr: {
      rows: ddr.length,
      wells: [...new Set(ddr.map((d) => d.well))],
      rigs: [...new Set(ddr.map((d) => d.rig))],
    },
    assumptions: [
      "Timestamps carry minute precision only. The minute is treated as the atomic time unit: rows are bucketed by the stamp given, within-minute row order is taken as-is, and no sub-minute timestamps are invented. All statistics are computed over the raw samples inside each bucket, so within-minute variance survives aggregation.",
      "Feed gaps are never interpolated. 46 gaps totalling 351 minutes exist, including a 144-minute blackout on 10 Sep; chart lines break across them and rate denominators exclude them.",
      "Operational state is derived from change in hole depth, bit movement and block position - not from the ROP channel, which never reaches zero in this export and therefore cannot distinguish drilling from tripping.",
      "TORQUE is treated as ft-lb, not the kft-lb printed in the unit header row, because its range matches the offset-well torque ceiling for the same hole section.",
      "MFOP is treated as an uncalibrated flow-out reading rather than the percentage-of-flow-in the glossary describes, because with pumps running it has a median of 20 and never exceeds 69.",
      "The telemetry file carries no well identifier. It is matched to SEBL_002 on rig PHR-026 by time overlap with the DDR and confirmed on depth (feed starts at 794.79 ft and ends at 4062.19 ft; the DDR reports 795 ft and 4062 ft at the same moments).",
      "Timestamps are naive rig local time. The source carries no timezone marker, so none is assumed; everything is labelled and rendered as rig time.",
    ],
  };

  // ---- write ---------------------------------------------------------------
  console.log("\n[5/5] Writing artefacts to data/processed/");
  write("manifest.json", manifest);
  write("quality.json", tel.findings);
  write("minutes.json", tel.minutes);
  write("spans.json", spans);
  write("agreement.json", agreement);
  write("anomalies.json", anomalies);
  write("summary.json", summary);
  write("intervals.json", { hourly, fourHourly, daily });
  write("series.json", series);
  write("rop-wob.json", ropWob);
  write("ddr.json", ddr);
  write("offsets.json", offsets);

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main();

export {};
