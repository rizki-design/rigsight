/**
 * Shared domain types for the RigSight pipeline and API.
 *
 * All timestamps are epoch milliseconds (UTC) unless a field name says otherwise.
 * The source feed carries rig local time with no zone marker; we keep it naive and
 * label it "rig time" everywhere rather than inventing a timezone.
 */

export type ChannelCode =
  | "DBTM" | "DMEA" | "BPOS" | "ROP" | "HKLA"
  | "WOB" | "TORQUE" | "RPM" | "SPP" | "MFOP" | "MFIA";

export const CHANNELS: ChannelCode[] = [
  "DBTM", "DMEA", "BPOS", "ROP", "HKLA", "WOB", "TORQUE", "RPM", "SPP", "MFOP", "MFIA",
];

/** Per-channel summary for one minute bucket. Dispersion is a first-class citizen:
 *  it is the stick-slip signal, so it survives downsampling. */
export interface ChannelStats {
  n: number;      // valid samples that minute (after cleaning)
  mean: number;
  min: number;
  max: number;
  sd: number;     // population standard deviation
  p10: number;
  p50: number;
  p90: number;
}

export type OpState =
  | "DRILLING"      // making hole, on bottom, rotating at surface
  | "SLIDING"       // making hole, on bottom, little/no surface rotation (mud motor)
  | "REAMING"       // rotating + circulating on/near bottom, not making new hole
  | "TRIPPING_IN"   // bit running into the hole
  | "TRIPPING_OUT"  // bit being pulled out of the hole
  | "CONNECTION"    // pumps off, short block travel, adding/removing a joint
  | "CIRCULATING"   // pumps on, bit essentially stationary, no new hole
  | "STATIC"        // nothing moving
  | "NO_DATA";      // inside a feed gap

export interface MinuteRecord {
  t: number;                    // minute bucket start, epoch ms
  n: number;                    // raw rows in this bucket
  dupRows: number;              // rows identical to the previous row (held frames)
  stats: Partial<Record<ChannelCode, ChannelStats>>;
  /** Derived, per-minute */
  holeDepth: number | null;     // DMEA at end of minute
  bitDepth: number | null;      // DBTM mean of valid (>0) samples
  offBottom: number | null;     // holeDepth - bitDepth, ft
  dHole: number;                // ft of new hole made this minute
  dBit: number;                 // ft the bit moved this minute (+ down / - up)
  ropCalc: number | null;       // ft/hr from dHole (our own, vs the smoothed ROP channel)
  /** Torque cleaned for the zero-fill artefact: stats over non-zero, de-duplicated samples */
  torqueValid: number;          // count of samples kept
  torqueZeroFill: number;       // count of exact-zero samples dropped while rotating
  torqueMedian: number | null;
  torqueNMad: number | null;    // 1.4826 * MAD / median - robust dispersion index
  torquePtp: number | null;     // (max - min) / median
  state: OpState;
  holeSize: string | null;      // from the DDR activity timeline, not guessed from depth
}

export interface FeedGap {
  from: number;
  to: number;
  minutes: number;
}

export type AnomalyType =
  | "STICK_SLIP"
  | "WASHOUT"
  | "FLOW_IMBALANCE"
  | "OVERPULL"
  | "ENVELOPE_EXCEEDANCE";

export type Severity = "WATCH" | "WARN" | "ALARM";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: Severity;
  confidence: Confidence;
  from: number;
  to: number;
  durationMin: number;
  depthFrom: number | null;
  depthTo: number | null;
  /** Plain-language line a drilling engineer can read without decoding the metric. */
  headline: string;
  /** The numbers the rule actually fired on, so the call is auditable. */
  evidence: Record<string, number | string | null>;
  /** Why this might be wrong - stated up front rather than hidden. */
  caveat?: string;
}

export interface DdrRow {
  idx: number;
  well: string;
  rig: string;
  field: string;
  start: number;
  end: number;                  // start + duration hours
  spud: number | null;
  wellPhase: string;
  phase1: string;
  phase2: string;
  activity: string;
  durationHrs: number;
  nptHrs: number;               // 0 when the source cell is blank
  holeSize: string | null;
  depthFt: number | null;
  comment: string;
}

export interface OffsetEnvelope {
  well: string;
  section: string;              // raw "Row Labels" text
  holeSize: string | null;      // parsed bit size, e.g. "12.25"
  maxRop: number;
  maxFlowRate: number;
  maxWob: number;
  maxSpp: number;
  maxPuWeight: number;
  maxTorque: number;
}

/** One auditable cleaning action, surfaced in the UI and at /api/quality. */
export interface QualityFinding {
  id: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  affectedRows: number;
  affectedPct: number;
  action: string;
}

export interface Manifest {
  generatedAt: string;
  well: string;
  rig: string;
  field: string;
  telemetry: {
    rawRows: number;
    malformedRows: number;
    from: number;
    to: number;
    minutes: number;
    coveredMinutes: number;
    missingMinutes: number;
    rowsPerMinute: { min: number; p50: number; mean: number; max: number };
    gaps: FeedGap[];
  };
  ddr: { rows: number; wells: string[]; rigs: string[] };
  assumptions: string[];
}
