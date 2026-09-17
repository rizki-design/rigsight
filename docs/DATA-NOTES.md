# Data notes

Everything found in the pack that changed how a number is computed, with the count it affects
and what was done about it. All of this is also served at `GET /api/quality` and shown in the
dashboard's **Data quality** tab, so the caveats travel with the data rather than living only
in a document.

**Dataset:** `realtime_rig_telemetry.csv` — 249,395 rows, 0 malformed, covering
**9 Sep 03:00 → 14 Sep 11:00 2026** rig time, which is 7,330 distinct minutes.

---

## 1. Timestamps carry minute precision only — CRITICAL

249,395 rows share 7,330 minute stamps. Per minute: minimum 1 row, median 35, mean 34,
maximum 60 — roughly one reading every 1.7 seconds. There is no seconds field. Within-minute
ordering is implied by row order alone, and row order is non-decreasing in time throughout the
file.

**Action.** The minute is the atomic time unit. Rows are bucketed by the stamp given,
within-minute order is taken as-is, and no sub-minute timestamps are invented. All statistics
are computed over the raw samples inside each bucket — nothing is interpolated or resampled
onto a synthetic grid before aggregation — so within-minute variance survives.

**Why it matters.** Within-minute variance is the entire stick-slip signal. Any pipeline that
resamples to a clean 10-second grid first has destroyed the thing it was built to detect.

**Cost, stated plainly.** A real stick-slip cycle has a period of roughly 1–10 s. At ~1.7 s
sampling we are at the edge of Nyquist and the signal is aliased. The dispersion index ranks
severity reliably but is not a calibrated stick-slip percentage and cannot recover cycle
frequency. Every stick-slip event carries MEDIUM confidence and says this on itself.

---

## 2. The ROP channel never reaches zero — CRITICAL

| Statistic | Value |
|---|---|
| Minimum | 0.02 ft/hr |
| Rows below 0.05 ft/hr | 48 of 249,395 |
| Distinct values in the whole file | 562 |
| Median | 1.72 ft/hr |

ROP sits at 1–3 ft/hr straight through trips, connections and repairs. It is a smoothed or
derived vendor channel, not a raw rate.

**Action.** Operational state is derived from the change in hole depth (`DMEA`), bit movement
and block position — never from `ROP > 0`. A separately computed `ropCalc = ΔDMEA/Δt` is
published next to the vendor channel so the two can be compared.

**Why it matters.** The glossary states "ROP = 0 means not currently making new hole". Applied
literally to this file, that rule classifies all five days as drilling — including a
seven-hour trip out of the hole on 12 September. It is the single most load-bearing wrong
assumption available in this pack.

**Knock-on effect.** It also means the obvious "average ROP" — the mean of the ROP column — is
meaningless, because it mixes real drilling rate with a floor value from hours when no hole was
being made. Over this window that mean is 3.14 ft/hr, against a measured on-bottom rate of
100.3 ft/hr. See `etl/aggregate.ts`.

---

## 3. TORQUE reports an exact 0 while the string is turning — CRITICAL

In **72% of rotating minutes** the torque channel returns an exact `0` on a median **12%** of
samples (75th percentile 22%, 95th percentile 36%). RPM in those same minutes is non-zero and
frequently climbing.

The control: **RPM shows the same artefact in only 4.8% of rotating minutes.** If the string
were genuinely stopping, both channels would stop together. They do not, so this is a
torque-channel dropout.

A single minute, 13 Sep 12:07, with RPM climbing smoothly from 41 to 62:

```
TQ=   0  RPM=41      TQ=2821  RPM=46      TQ=1195  RPM=59
TQ=   0  RPM=41      TQ=3337  RPM=47      TQ=2663  RPM=58
TQ=   0  RPM=44      TQ=   0  RPM=51      TQ=3774  RPM=62
                     TQ=   0  RPM=51      TQ=4488  RPM=58
                     TQ=1036  RPM=51      TQ=2028  RPM=60
```

**Action.** Exact zeros are excluded from torque statistics while RPM > 20. Consecutive
repeated (held) frames are also collapsed before computing dispersion.

**Why it matters.** Left in, these dropouts manufacture a full-amplitude torque oscillation in
every single rotating minute. A naive variance-based stick-slip detector fires on 100% of
rotating time, and every alert is a false positive. This is the difference between a system a
driller uses and one they mute in a week.

**Second-order consequence.** Even after cleaning, the residual is spiky, so **standard
deviation is the wrong dispersion metric** — it is dominated by outliers. The detector uses
normalised median absolute deviation (`1.4826 × MAD / median`), which is not.

---

## 4. The weight-on-bit channel has a zero-offset fault — CRITICAL

25,736 rows report WOB below zero, minimum −29.6 klb. That alone would be unremarkable —
negative surface WOB is normal off-bottom.

It is not confined to off-bottom time. Across **881 minutes where the well is unambiguously
being deepened** — hole depth advancing, bit on bottom, 40+ RPM — the WOB channel reads:

| Percentile | WOB while definitely drilling |
|---|---|
| p05 | −12.7 klb |
| p25 | −7.4 klb |
| p50 | **−1.1 klb** |
| p75 | +1.8 klb |
| p95 | +4.6 klb |

**58% negative.** A bit cutting rock at 90–170 ft/hr is not doing it under negative weight.

**Action.** The absolute WOB reading is treated as untrustworthy. Nothing gates on WOB level:
on-bottom is established from bit depth against hole depth, and the stick-slip rule uses WOB's
**standard deviation**, which is immune to a constant offset — and which is the more correct
physics anyway, since stick-slip is torque swinging while weight holds *steady*, not while
weight is *high*.

**Worth escalating.** A mis-tared WOB sensor does not only mislead a dashboard; it misleads
the driller at the brake.

---

## 5. Mud Flow Out is not the percentage the glossary describes — WARN

Documented as flow-out as a percentage of flow-in, expected near 100%. Measured, with pumps
running above 300 gpm across 129,540 rows:

| Statistic | Value |
|---|---|
| p05 | 7 |
| p50 | **20** |
| p95 | 27 |
| max | 69 |

It never approaches 100 and has no physical interpretation as a ratio. It is an uncalibrated
flow-out sensor reading.

**Action.** The glossary's "MFOP near 100%" rule is not applied. Flow imbalance is scored only
as relative drift from the channel's own rolling baseline while flow-in holds steady, and every
such event is published at **LOW confidence** with an explicit instruction to confirm the
sensor scaling before acting. No flow-imbalance events cleared the threshold in this window.

---

## 6. The TORQUE unit row disagrees with the values — WARN

The header unit row reads `kft.lb`. The channel reaches **5,979**.

`offset_wells_master.csv` caps `Max of DRL_TORQUE` for the 8½" section — the same section this
well drilled for almost the entire window — at **7,700**. The two are plainly on the same
scale.

**Action.** Telemetry torque is treated as **ft·lb** throughout, so the offset comparison is
like-for-like.

**Why it matters.** Taken at face value, every torque reading in the file would appear roughly
1000× over the historical ceiling, and the envelope detector would raise a continuous alarm for
five days.

---

## 7. Bit depth reads 0 for a six-hour block — WARN

14,309 rows report `DBTM = 0`. They are not scattered: **every one falls inside 9 Sep
08:50–14:55.**

The DDR for that window shows mud-pump performance testing, a choke drill, and BHA make-up —
with the string out of the hole. So `0` means "no valid bit depth", not "bit at surface at
depth zero".

**Action.** Treated as missing rather than as a depth of zero.

**Why it matters.** Plotted literally, the bit-depth trace drops to surface and the
depth-versus-time chart — the first thing anyone looks at — becomes unreadable.

---

## 8. Non-numeric cells inside a numeric channel — WARN

12 cells fail numeric parsing. All are in `WOB`, all read `5.0E`, and all fall between
13 Sep 06:22 and 06:27 — a scientific-notation literal truncated on export.

**Action.** Left as missing. Coercing to `0` would fabricate a zero-weight-on-bit reading in
the middle of a drilling interval, which is exactly the kind of silent corruption that is
impossible to find later.

---

## 9. Repeated (held) sensor frames — WARN

**27,822 rows are byte-identical to the row immediately before them** — 11.2% of the file —
occurring in 16,974 consecutive runs, the longest being 44 rows. The feed re-publishes the last
value when no new reading has arrived.

A separate and larger figure is worth not confusing with it: **65,425 rows (26.2%) are
non-unique somewhere in the file.** That one is mostly meaningless here, because a rig sitting
still legitimately produces the same reading again hours later. Only the consecutive repeats
are evidence of a held frame, and only those are counted.

**Action.** Counted and reported. Consecutive repeats are collapsed before computing torque
dispersion.

**Why it matters.** Leaving them in pulls variance toward zero — the opposite failure mode to
the zero-fill dropouts, and it masks real oscillation.

---

## 10. Feed gaps, including a 144-minute blackout — WARN

46 gaps totalling **351 missing minutes** (5.85 hours). The largest:

| Gap | Duration | Context |
|---|---|---|
| 10 Sep 10:03 → 12:27 | **144 min** | mid 8½" drilling, 1042 → 1480 ft |
| 11 Sep 21:37 → 22:37 | 60 min | pattern drilling |
| 13 Sep 22:06 → 22:32 | 26 min | pattern drilling |
| 12 Sep 11:19 → 11:44 | 25 min | equipment repair (3 hr NPT in the DDR) |

**Action.** Gaps are never interpolated. Chart lines break across them, rolling-window
calculations refuse to span them, and every rate denominator excludes them.

**Why it matters.** Counting the 144-minute blackout as drilling time would understate ROP for
that interval by roughly a third. Drawing a line across it would imply the rig was doing
something smooth and known during two hours nobody was measuring.

---

## Joining the files

The telemetry file carries **no well or rig identifier** — only `dtsrv` and 11 channels.

It was matched to **SEBL_002 / PHR-026** by:

1. **Time overlap.** The feed covers 9–14 Sep 2026. `SEBL_001` ran 18 Nov 2025 – 1 Feb 2026;
   `SEBL_002` ran 15 Aug – 15 Sep 2026. Only one overlaps.
2. **Depth confirmation.** The feed opens at `DMEA = 794.79 ft` and closes at `4062.19 ft`. The
   DDR for SEBL_002 reports **795 ft** at 9 Sep and **4062 ft** at 14 Sep — the same numbers at
   the same moments.

That join is what makes the rest possible: hole size comes from the DDR's `WBORESZACT` timeline
rather than being guessed from depth, state detection is validated against the driller's
activity codes, and the overpull detector can be checked against a human narrative it never
reads.

`WBORESZACT` is written as `12.25` / `8.5` / `6 1/8` in the DDR and as
`Drill 12-1/4" Hole Section` in the offset table. Both are normalised to a decimal-inch string
so the two files join without a hand-maintained lookup.

---

## A note on the DDR file

568 rows, two wells, two rigs. Parsed with a hand-written CSV reader rather than a library
because the `COM` column contains quoted, multi-line narrative with embedded `""` escapes,
stray carriage returns and an explicit `=== After Midnight ===` separator mid-field. Comments
run up to 1,946 characters and are the richest field in the pack; a parser that truncates them
silently loses most of the value.

`UNSCHEDULE_EVENT_HRS` is **blank**, not `0`, when no non-productive time was reported. Blank
is read as 0 for arithmetic, but "NPT was reported as zero" and "the field was left empty" are
different claims, so only rows with a real value are counted as NPT events.

Across the whole file the DDR books **923.5 hours of NPT against 2,562 hours total — 36%.**
Within the five-day telemetry window it is 14.75 hours of 131.5.
