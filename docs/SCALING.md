# Scaling to 50 rigs streaming simultaneously

What this build is, honestly: a single-process Next.js app reading precomputed JSON for one
well over a fixed five-day window. It is shaped for a case study, not for production. But the
boundaries were drawn where production would want them, so the changes below are replacements
of specific pieces rather than a rewrite.

---

## The numbers first

One rig, measured from this pack:

- ~34 rows/minute × 12 channels ≈ **410 values/minute**, about 7 Hz of scalar readings
- 249,395 rows for 5.3 days ≈ **47,000 rows/rig/day**

Fifty rigs:

- **~2.4 million rows/day**, ~28 rows/second aggregate, ~350 scalar values/second
- At ~60 bytes/row raw, roughly **140 MB/day**, ~50 GB/year before compression

**This is a small-data problem.** That is the most important thing to say about it. Fifty rigs
at 2-second sampling is comfortably inside what one well-chosen time-series database handles on
modest hardware. The instinct to reach for Kafka, Spark and a lakehouse would be
over-engineering by two orders of magnitude, and the real difficulty is not throughput.

**The real difficulties are: connectivity, per-rig calibration, and alert trust.**

---

## Target architecture

```
rig WITSML / OPC-UA ──┐
                      ├──► ingest (per-rig connector)
                      │       ├── store raw immutably, before any cleaning
                      │       └── publish to a queue
                      ▼
              stream processor ──► per-minute rollups (mean/min/max/sd/count)
                      │                └──► time-series DB (TimescaleDB, hypertable)
                      │
                      ├──► state classifier  ──► state spans table
                      └──► detectors         ──► events table
                                                      │
                      read API (this repo's endpoints, unchanged in shape)
                                                      │
                                       dashboard · alerting · reports
```

### 1. Ingest — the part that is actually hard

Rigs lose connectivity. This pack proves it: **46 gaps in five days, including a 144-minute
blackout**, on a dataset someone had already cleaned up enough to send out. The ingest layer
has to assume the link is unreliable, not treat it as an exception.

- **Store raw before cleaning, immutably.** Every finding in
  [DATA-NOTES.md](DATA-NOTES.md) came from inspecting raw values. A pipeline that cleans on
  ingest and discards the original cannot discover that its torque channel zero-fills, because
  the evidence is gone.
- **Buffer at the rig and backfill.** Out-of-order and late-arriving data is the normal case.
  Rollups must be recomputable for a window that has already been written, which means the
  aggregation has to be idempotent and keyed on (rig, minute).
- **Gaps are first-class records**, not absences. They already are in this build — the API
  returns them as a list and emits `null` points that break chart lines.
- **Per-rig schema drift.** PHR-05 and PHR-026 are different rigs and there is no guarantee
  they publish identical channel names, units or scaling. The `5.0E` cells and the mislabelled
  `kft.lb` unit row in this one file are a preview.

### 2. Storage — TimescaleDB

PostgreSQL with a time-series extension, hypertable partitioned on time and `rig_id`.

Chosen over a bespoke store because the workload is genuinely relational: joining telemetry to
daily drilling reports, activity codes, offset envelopes and bit records is most of the value,
and that join is what made the cross-validation in this project possible. Continuous aggregates
compute the per-minute rollups incrementally, which is exactly what `etl/aggregate.ts` does by
hand today.

**The rollup schema does not change.** Per minute, per channel: `count, mean, min, max, sd`,
plus the robust dispersion index for torque. That shape is already what the ETL produces and
what `/api/timeseries` returns, and it exists for one reason — **so variance survives
downsampling.** A rollup that keeps only the mean throws away the stick-slip signal at the
storage layer, where it cannot be recovered.

Retention: minute rollups indefinitely (~50 GB/year for 50 rigs is nothing), raw samples on a
shorter window with cold-storage archival.

### 3. Processing

The ETL becomes a stream processor, but the code inside it barely changes. `classify()`,
`detectStickSlip()` and the rest are pure functions over a window of minutes — they were
written that way on purpose. They move from a batch loop to a windowed stream operator.

Two things must be added:

- **Idempotency.** Re-processing a backfilled window must not duplicate events. Events get a
  deterministic key of (rig, detector, window start).
- **State recovery.** The rolling baselines — trailing SPP median, trailing pick-up weight —
  have to survive a restart, which means checkpointing rather than recomputing from the start
  of the well.

### 4. What breaks first, and in what order

1. **Alert fatigue, long before throughput.** Fifty rigs × the current detector sensitivity is
   roughly 500 events a day. Nobody reads that. This needs per-rig baselining, deduplication,
   severity routing, and an acknowledge/mute path. Precision matters more than recall once a
   human is in the loop — an alert nobody trusts is worse than no alert.
2. **Per-rig calibration.** Every threshold in `DEFAULT_CONFIG` is calibrated against *this*
   well's measured distributions. The stick-slip dispersion index is explicitly a relative
   measure with no universal scale. At 50 rigs these must become per-rig, per-hole-section
   baselines learned from that rig's own recent history — which also finally makes an ML
   approach reasonable, because there would be enough labelled history to train on.
3. **The dashboard payload.** One well currently ships a trimmed payload to the browser. A
   fleet view needs server-side windowing, and the per-minute cockpit array has to become a
   range query rather than a full send.
4. **Sensor health as a product feature.** The WOB zero-offset and the torque zero-fill found
   here are not one-off curiosities — they are what a fleet of rigs looks like all the time.
   The data-quality report at `/api/quality` should become a continuously running,
   per-rig sensor-health monitor with its own alerts. On a 50-rig fleet, "rig 34's WOB sensor
   has been reading 10 klb low for a week" is worth more than most anomaly detection, because
   it is certain, actionable, and silently corrupting every other number on that rig.

### 5. What does *not* need to change

- The API contract. Adding `rigId` to the endpoints covers the fleet case; the response shapes,
  including gap nulls and the min/max/sd envelope, are already right.
- The detector logic, for the reason above.
- The decision to keep rules explainable. It gets *more* important with scale, not less — at 50
  rigs, an unexplainable flag becomes 50 unexplainable flags and the system gets switched off.
- Serving the data-quality findings as data alongside the numbers they qualify.

---

## The honest summary

The engineering at 50 rigs is not hard. Two and a half million rows a day is a normal day for
one Postgres box, and the detector code is already pure functions over windows.

What is hard is that each rig lies differently. This one well needed four separate corrections
before a single number could be trusted, and none of them were discoverable from the
documentation — they only showed up by measuring the raw channels against each other. Fifty
rigs means fifty sets of those, changing whenever a sensor is swapped.

So the thing to build first at scale is not a bigger pipeline. It is the per-rig sensor-health
layer that finds the next `5.0E`, the next mislabelled unit row, and the next negative
weight-on-bit — automatically, and before it reaches a dashboard someone is making decisions
from.
