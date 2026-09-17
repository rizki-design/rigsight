# RigSight

A drilling telemetry dashboard and anomaly-detection API, built on five days of real
(anonymised) operations data from **SEBL_002 / rig PHR-026**.

It answers three questions a drilling engineer actually asks:

1. **What is the rig doing right now?** — operational state computed from the sensor feed
2. **Is anything going wrong?** — stick-slip, washout, overpull and envelope detectors that
   publish the evidence they fired on
3. **What happened, and why?** — searchable daily drilling reports with exact citations

> **Tracks.** This covers the core item of both tracks, plus one stretch. I led with
> **Track B's** lens — get the data honest first, then expose it — and built **Track A's**
> dashboard on top of the same computation layer. See
> [Scope and why both tracks](#scope-and-why-both-tracks) for why this cost roughly 30% more
> than one track rather than 100%.

---

## Quick start

```bash
npm install && npm run build && npm start
```

Then open <http://localhost:3000>.

`npm run build` runs the ETL first (`npm run etl`), which turns the three raw CSVs in
`data/raw/` into cleaned, analysed artefacts in `data/processed/`. Those artefacts are
committed, so the app runs immediately after a clone. Takes about 10 seconds.

For development with hot reload:

```bash
npm run dev
```

**No API key is needed.** The DDR assistant answers from retrieval by default. Setting
`ANTHROPIC_API_KEY` additionally enables a "LLM summary" toggle that passes the same
retrieved rows to Claude for a more fluent answer — the citations are identical either way.

---

## The single most important thing in this repo

**The telemetry feed is not what the glossary says it is, and taking it at face value
produces a dashboard that is confidently wrong.**

Four findings changed the design. Each is measured, counted, and surfaced at
`/api/quality` and in the dashboard's **Data quality** tab — not buried here.

| What the documentation says | What the data actually does | Consequence if believed |
|---|---|---|
| `ROP = 0` means not making hole | ROP **never** reaches zero. Minimum 0.02 ft/hr, only 562 distinct values in 249,395 rows, sits at 1–3 ft/hr straight through trips and connections | The naive state rule classifies all five days as "drilling", including a seven-hour trip out of the hole |
| `TORQUE` is the stick-slip signal | The torque channel returns an **exact 0** on a median 12% of samples in 72% of rotating minutes, while RPM in those same minutes is non-zero and climbing | A variance-based stick-slip detector fires on 100% of rotating time. All false positives |
| `WOB` is weight on bit | Across 881 minutes where the well is unambiguously being deepened, WOB reads **negative 58% of the time** (median −1.1 klb) | Any rule gated on "WOB above a threshold" discards most real drilling |
| `MFOP` is flow-out as a % of flow-in, ~100% | With pumps above 300 gpm it has a **median of 20** and never exceeds 69 | The documented flow-imbalance rule cannot be applied at all |

Full detail and the reasoning in **[docs/DATA-NOTES.md](docs/DATA-NOTES.md)**.

### How the irregular timestamps were handled

The feed carries **minute precision only**. About 34 rows share each minute stamp (min 1,
median 35, max 60) — roughly one reading every 1.7 seconds — and there is no seconds field.
Row order is the only within-minute ordering information that exists.

**Decision: bucket by the minute given, treat within-minute row order as-is, and never
invent sub-minute timestamps.**

- Every statistic is computed over the **raw samples inside each bucket**. Nothing is
  interpolated or resampled onto a synthetic grid before aggregation, so within-minute
  variance — which *is* the stick-slip signal — is measured on real samples.
- The minute is the atomic time unit of the whole system. Nothing in the API or UI claims
  sub-minute resolution, because the data cannot support it.
- **Gaps are never bridged.** 46 gaps totalling 351 minutes exist, including a 144-minute
  blackout on 10 Sep during 8½" drilling. Chart lines break across them and every rate
  denominator excludes them.

The honest cost, stated on every stick-slip event this raises: a real stick-slip cycle has a
period of 1–10 s. At ~1.7 s sampling we are at the edge of Nyquist and the signal is aliased.
So stick-slip is published as a **relative severity index with MEDIUM confidence**, not as a
calibrated percentage. Fixing that needs 1 Hz torque, not a better algorithm.

---

## What it found

### The detector reproduced the driller's own notes, from sensors alone

The 14 Sep daily report says, in free text, that the crew found drag of 10–12 klb at
**3740, 3465, 3360 and 3250 ft** while pulling out of the hole.

The overpull detector — which never reads the comment field — independently flagged
**3744 / 3741 / 3742 ft**, **3465 ft**, and **3354 / 3347 ft** on that trip, and ranked
3465 ft as the worst: a 28.8 klb overpull with hookload peaking at **172.7 klb**, which is the
highest hookload anywhere in the five days.

It then goes one step further. Every one of those four depths had **stick-slip events detected
while drilling through them on the way down** — 3719 ft, 3468/3498/3512 ft, 3301/3342/3360/3367 ft
and 3289/3301 ft. Two independent sensor-derived signals agreeing with a human narrative that
neither of them ever saw: high torque oscillation going in, drag coming out, at the same depths.

That finding is why the overpull detector is scored across the **whole trip episode** rather
than only on minutes classified as tripping. The first version missed the 3465 ft event
entirely — because when a string is genuinely hung up the blocks stop moving, the state
machine correctly reports STATIC, and a detector gated on "currently tripping" skips exactly
the minutes that matter most. The harder the string is stuck, the more certainly it is missed.

### The ROP number everyone quotes is the wrong one

| Metric | Value | What it means |
|---|---|---|
| ROP on bottom | **100.3 ft/hr** | footage ÷ hours actually making hole — bit performance |
| ROP overall | **29.2 ft/hr** | footage ÷ all measured hours — what predicts when the well finishes |
| Vendor ROP channel mean | **3.14 ft/hr** | the supplied `ROP` column, averaged — meaningless here |

All three are returned by `/api/aggregates`. The third is published *only* so the gap is
visible: averaging a channel that never reads zero mixes drilling rate with a floor value from
hours when no hole was being made at all.

The rig made 3,562.9 ft in 122.2 measured hours. **35.5 of those hours were spent making hole.**

---

## Architecture

```
data/raw/*.csv                  the pack as delivered, untouched
        │
        ▼
etl/  (npm run etl, ~10s)       parse → clean → classify → detect → aggregate
        │                       every cleaning action counted and reported
        ▼
data/processed/*.json           committed artefacts; reviewable in a diff
        │
        ▼
src/app/api/*                   Next.js route handlers, read-only over the artefacts
        │
        ▼
src/app/page.tsx                server component → trimmed payload → dashboard
```

**Why the ETL is a separate step rather than runtime work.** Parsing 250k rows per rig on
every request does not survive 50 rigs. Precomputing also makes the cleaning *reviewable*: a
change to a cleaning rule shows up as a diff in `data/processed/`, so it can be argued about in
a pull request instead of taken on trust.

**Why no charting library.** Every series carries a min/max envelope and a standard
deviation, because the short-timescale spread is the signal. A default line chart plots the
mean and throws the rest away — the exact failure the brief warns about — and most libraries
will happily draw a straight line across a 144-minute feed gap. The SVG primitives in
`src/components/charts.tsx` render the band and break on nulls.

**Dependencies: `next`, `react`, `react-dom`.** That is the entire runtime dependency list.
No pandas, no chart library, no vector database. `npm audit` reports zero vulnerabilities.

### Layout

| Path | What lives there |
|---|---|
| `etl/parse-telemetry.ts` | the cleaning rules and the quality report — **start here** |
| `etl/state.ts` | operational state machine + validation against the DDR |
| `etl/anomalies.ts` | the four detectors, with thresholds calibrated on this well |
| `etl/aggregate.ts` | progress and the three ROP definitions |
| `src/lib/search.ts` | BM25 retrieval over the report narratives |
| `src/components/charts.tsx` | SVG chart primitives |
| `docs/` | data notes, scaling, brief, reflections |

---

## API

All endpoints return JSON. Timestamps are epoch milliseconds in rig local time.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness + dataset fingerprint |
| `GET /api/wells` | well metadata, coverage, assumptions, state-detection agreement |
| `GET /api/timeseries` | aggregated channels — **carries min/max/sd at every resolution** |
| `GET /api/aggregates` | progress and ROP per 1h / 4h / 1d interval |
| `GET /api/state` | operational state timeline, or the state at one instant |
| `GET /api/anomalies` | detected events with evidence, confidence and caveats |
| `GET /api/quality` | the data-quality report as data |
| `GET /api/offset-envelope` | offset-well ceilings vs what this well actually did |
| `GET /api/ddr` | the structured report log, filterable |
| `POST /api/ddr/query` | retrieval over report narratives, with citations |

### Examples

Torque with its variance preserved, hourly:

```bash
curl "http://localhost:3000/api/timeseries?channels=TORQUE,TORQUE_DISPERSION&resolution=60"
```

Every point returns `{t, mean, min, max, sd, n}`. `sd` is aggregated as a root-mean-square of
the per-minute spreads, so **variance survives downsampling** instead of being averaged away.
`null` points mark feed gaps and should break the line. `TORQUE_DISPERSION` is the robust
dispersion index (normalised MAD) the stick-slip detector fires on — the resampling-safe
version of "how hard is torque swinging".

Only the serious events:

```bash
curl "http://localhost:3000/api/anomalies?minSeverity=WARN"
```

Ask the reports a question:

```bash
curl -X POST http://localhost:3000/api/ddr/query \
  -H "content-type: application/json" \
  -d '{"query":"what caused NPT on SEBL_002","filters":{"well":"SEBL_002","nptOnly":true}}'
```

Filters: `well`, `rig`, `activity`, `phase`, `holeSize`, `nptOnly`, `from`, `to`, `depthMin`,
`depthMax`. "night shift" / "day shift" in the query text is detected and applied as a time
filter.

---

## Operational state detection

States: `DRILLING`, `SLIDING`, `REAMING`, `TRIPPING_IN`, `TRIPPING_OUT`, `CONNECTION`,
`CIRCULATING`, `STATIC`.

Derived from what the rig is physically doing — change in hole depth, bit movement, block
position, rotary speed, flow — and explicitly **not** from the ROP channel, for the reason in
the table above.

Both depth channels update in quantised steps, so hole advance is judged over a centred
7-minute window and trips over a 15-minute window. The longer trip window is what separates a
trip from a connection: a connection is a round trip (bit up a stand, pipe added, bit back
down) whose net displacement over a quarter of an hour is near zero, while a real trip keeps
going one way.

### Checked against the driller's own report

The DDR is an independent, human-written account of the same five days, so each activity code
is mapped to the states we would expect and agreement is measured: **60.8% over 7,285 scored
minutes**, with tripping out at 74%, tripping in at 66%, equipment repair at 95% and surface
equipment testing at 100%.

**This is a sanity check, not a target, and it should not be optimised toward 100%.** A report
line reading "TIH, 8 hrs" is a coarse envelope that also contains the circulating and
connection breaks inside that trip, which the sensors resolve at minute scale and the
paperwork rounds off. Much of the disagreement is the detector being *more* precise than the
form it is compared against — which is the entire point of doing this from telemetry.

The clearest example: the DDR books **73.0 hours** of drilling-coded activity inside this
window. The sensors say the bit was actually deepening the hole for **35.5 of them** - 49%.

---

## Anomaly detection

Rule-based, not learned. Five days of one well with no labelled events is nowhere near enough
to train anything that generalises — and on a rig, a flag nobody can explain is a flag nobody
acts on. Every event publishes the numbers it fired on.

Three rules shared by all four detectors:

1. **Gate first.** Each detector only looks at minutes where its signal is physically
   meaningful. Torque variance means nothing while the string is stationary; a pressure drop
   means nothing with the pumps off. Most false positives in this kind of system are a correct
   rule applied in the wrong rig state.
2. **Require persistence.** Single-minute excursions are noise at this sampling rate.
3. **Publish confidence and caveat.** Two of these signals are compromised by the data itself,
   and they say so on the event rather than in a footnote.

| Detector | Signal | Found | Confidence |
|---|---|---|---|
| Stick-slip | normalised MAD of cleaned torque, on bottom, RPM and WOB steady | 20 | MEDIUM — aliased, see above |
| Overpull | hookload peak vs trailing normal pick-up, across a trip-out episode | 22 | HIGH |
| Washout | SPP ≥8% below trailing median while flow holds within 3%, sustained 5 min | 1 | MEDIUM |
| Envelope | channel p90 above the offset well's ceiling for the same hole size | 8 | HIGH |
| Flow imbalance | relative drift of flow-out against its own baseline | 0 | LOW — channel is mis-scaled |

Standard deviation was the obvious dispersion metric for stick-slip and it is the wrong one:
the residual torque dropouts are outliers, and standard deviation is dominated by outliers
while median absolute deviation is not.

Thresholds are calibrated against this well's own measured distributions, not a textbook —
the dispersion index is a relative measure with no universal scale. They live in
`DEFAULT_CONFIG` in `etl/anomalies.ts` with the percentile each one corresponds to.

---

## DDR assistant / retrieval

BM25 over the free-text `COM` narrative, with the coded columns indexed alongside it and used
as hard filters. Every answer carries row-level citations that point back at the source CSV.

**Lexical, not vector — deliberately.** 568 rows do not need an approximate index. The
questions here are dominated by exact rare tokens — depths, codes like `EQRPR`, tool names —
which is precisely where dense retrieval underperforms BM25. Citations must be exact, and it
runs with no API key and no network, so a walkthrough cannot fail on stage. At field scale
this becomes hybrid retrieval: BM25 for rare exact tokens, embeddings for paraphrase, fused by
reciprocal rank.

Three tuning decisions worth knowing about, each driven by an observed failure:

- **`k1 = 0.8`, not the textbook 1.5.** Drilling reports are repetitive equipment lists. A
  rig-move note saying "pipe" 13 times outranked a drilling report reading *"Got tight spot @
  4761"* — where "tight" appears once, in 2 of 568 documents. Faster term-frequency saturation
  fixes it.
- **Coordination factor.** Score scales by the square root of the fraction of query concepts a
  document matches, so covering the question beats repeating one word.
- **An NPT prior on problem-intent queries.** The NPT column is independent evidence that a
  line describes something going wrong, which the prose alone often hides.

The synonym list in `src/lib/search.ts` is plain data a drilling engineer can read and correct
— which an embedding is not. It also carries a scar: `"pack"` (for pack-off) was removed after
it matched **"Power Pack"**, a generator on a truck manifest, and pushed a loading list to the
top of a stuck-pipe query.

---

## Scope, and why both tracks

The brief asks for one core item and warns against doing three things shallowly. Two cores
were built anyway, for a specific reason: **they share one computation layer.**

Track B's core is an API over cleaned, state-classified, anomaly-scored telemetry. Track A's
core is a dashboard displaying cleaned, state-classified, anomaly-scored telemetry. The
expensive part — understanding the feed well enough to trust a number from it — is the same
work twice. Building both cost roughly 30% more than one, not 100%, and the ~4 focused hours
went overwhelmingly into the data layer rather than into feature count.

**Deliberately cut:**

- **No live streaming.** The data is a five-day historical export. It is presented as a
  *replay* with a scrubber, because claiming "live" would be the first thing a drilling
  engineer caught.
- **No ML.** Explained under Anomaly detection.
- **No vector database.** Explained under DDR assistant.
- **No auth, no multi-tenancy, no persistence.** One well, one reviewer, read-only.
- **Connection detection is weak** (1.7 hours found across 3,563 ft, which is low). It is the
  hardest state to separate on this rig because the flow channel often stays above the pumping
  threshold straight through a connection. Left honest rather than tuned until the number
  looked right.
- **Circulating while reciprocating the string** is misread as short trips — the string
  genuinely is moving. 209 minutes of `CC` activity, the largest single source of disagreement.

---

## Further reading

- **[docs/DATA-NOTES.md](docs/DATA-NOTES.md)** — every data-quality finding, with counts and reasoning
- **[docs/SCALING.md](docs/SCALING.md)** — what changes at 50 rigs streaming simultaneously
- **[docs/BRIEF.md](docs/BRIEF.md)** — the half-page summary
- **[docs/REFLECTIONS.md](docs/REFLECTIONS.md)** — if I had another week
- **[docs/glossary.md](docs/glossary.md)** — as supplied with the data pack

---

## Notes

Timestamps are naive rig local time. The source carries no timezone marker, so none is
assumed; everything is labelled and rendered as rig time.

The telemetry file carries no well identifier — only a timestamp and 11 channels. It was
matched to SEBL_002 on rig PHR-026 by time overlap with the DDR and confirmed on depth: the
feed opens at 794.79 ft and closes at 4062.19 ft, and the DDR reports 795 ft and 4062 ft at
exactly those moments.
