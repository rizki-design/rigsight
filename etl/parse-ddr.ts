import { readFileSync } from "node:fs";
import { parseCsv, parseFeedTimestamp, num } from "./lib/csv.js";
import type { DdrRow, OffsetEnvelope } from "../src/lib/types.js";

const HOUR = 3_600_000;

/**
 * Daily Drilling Reports: one row per reported activity block.
 *
 * Two things matter for downstream use:
 *
 * 1. Each row is an INTERVAL, not an instant. The file gives a start time and a
 *    duration in hours, so the activity window is [start, start + duration). That
 *    is what lets us line the driller's own account of the shift up against the
 *    sensor feed, minute for minute.
 *
 * 2. `UNSCHEDULE_EVENT_HRS` is blank rather than 0 when there was no non-productive
 *    time. Blank means "none reported", so it is read as 0 for arithmetic - but
 *    "NPT was reported as zero" and "the field was left empty" are not the same
 *    claim, and only rows with a real value are counted as NPT events.
 */
export function parseDdr(path: string): DdrRow[] {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const at = (r: string[], name: string) => r[header.indexOf(name)] ?? "";

  const out: DdrRow[] = [];
  rows.slice(1).forEach((r, i) => {
    if (r.length < header.length) return;

    // DTTMSTARTCALC is the reconciled start time and is populated on every row;
    // DTTMSTART is the raw entry and is occasionally missing the time component.
    const start = parseFeedTimestamp(at(r, "DTTMSTARTCALC")) ?? parseFeedTimestamp(at(r, "DTTMSTART"));
    if (start === null) return;

    const durationHrs = num(at(r, "DURATION")) ?? 0;
    const holeSizeRaw = at(r, "WBORESZACT").trim();

    out.push({
      idx: i,
      field: at(r, "FIELDNAME").trim(),
      well: at(r, "WELLIDE").trim(),
      rig: at(r, "RIGNO").trim(),
      start,
      end: start + durationHrs * HOUR,
      spud: parseFeedTimestamp(at(r, "DTTMSPUD")),
      wellPhase: at(r, "WELLPHASE").trim(),
      phase1: at(r, "PHASE1").trim(),
      phase2: at(r, "PHASE2").trim(),
      activity: at(r, "ACTIVITY").trim(),
      durationHrs,
      nptHrs: num(at(r, "UNSCHEDULE_EVENT_HRS")) ?? 0,
      holeSize: holeSizeRaw === "" ? null : normaliseHoleSize(holeSizeRaw),
      depthFt: num(at(r, "DEPTHACT")),
      comment: at(r, "COM"),
    });
  });

  return out.sort((a, b) => a.start - b.start);
}

/**
 * Hole size is written three different ways across the two files: "12.25" and "8.5"
 * in the DDR, and `Drill 12-1/4" Hole Section` in the offset table. Both are
 * normalised to a decimal-inch string so the offset envelope can be joined to the
 * live feed without a hand-maintained lookup.
 */
export function normaliseHoleSize(raw: string): string | null {
  const s = raw.trim().replace(/"/g, "");
  const mixed = s.match(/(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)/); // 12-1/4, 6 1/8
  if (mixed) {
    const v = +mixed[1] + +mixed[2] / +mixed[3];
    return trimNum(v);
  }
  const plain = s.match(/(\d+(?:\.\d+)?)/);
  return plain ? trimNum(+plain[1]) : null;
}

function trimNum(v: number): string {
  return String(+v.toFixed(3));
}

/**
 * Offset-well operating envelope: the highest value each parameter historically
 * reached on the reference well while drilling a given hole section. Used as a
 * rough "has today gone past anything we have seen before" ceiling.
 */
export function parseOffset(path: string): OffsetEnvelope[] {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const at = (r: string[], name: string) => r[header.indexOf(name)] ?? "";

  return rows
    .slice(1)
    .filter((r) => r.length >= header.length && at(r, "well_name").trim() !== "")
    .map((r) => {
      const section = at(r, "Row Labels").trim();
      return {
        well: at(r, "well_name").trim(),
        section,
        holeSize: normaliseHoleSize(section),
        maxRop: num(at(r, "Max of ROP")) ?? 0,
        maxFlowRate: num(at(r, "Max of FLOW_RATE")) ?? 0,
        maxWob: num(at(r, "Max of WOB")) ?? 0,
        maxSpp: num(at(r, "Max of SPPDRILL")) ?? 0,
        maxPuWeight: num(at(r, "Max of PU_WEIGHT")) ?? 0,
        maxTorque: num(at(r, "Max of DRL_TORQUE")) ?? 0,
      };
    });
}
