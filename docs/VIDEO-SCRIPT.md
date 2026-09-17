# Video walkthrough script — 3 minutes maximum

**Before you record**

```bash
npm run build && npm start
```

Open <http://localhost:3000>, drag the **Replay** slider to about **13 Sep midday** (so the
header shows an interesting state and ideally the high-torque alert), then reload nothing —
just start recording. Have a second browser tab open on
`http://localhost:3000/api/timeseries?channels=TORQUE&resolution=60` ready to switch to.

Total word count below is ~430, which is about 2 min 50 s at a calm pace. **Do not rush.** If
you run long, cut the DDR assistant (the last 10 seconds of Minute 1) — it's the stretch item,
not the core.

---

## MINUTE 1 — the thing running (0:00 – 1:00)

> *[Overview tab, full screen]*

"This is RigSight. It's built on five days of telemetry from well SEBL_002, rig PHR-026 —
about 250,000 sensor rows.

Top left tells you what the rig is doing right now — that's computed from the sensor feed, not
from a status field, because there isn't one. *[point at the state chip]* And when torque
starts swinging, this high-torque alert fires. *[point, if visible]*

The main chart is depth against time. Blue is how deep the hole is, pink is where the bit
actually is. When they separate — *[point at the 12 Sep divergence]* — that's a trip: the bit
is coming out while the hole stays where it is.

The coloured band underneath is the operational state, minute by minute. Green is drilling,
purple is tripping out, amber is a connection.

Two things I want you to notice. *[point at a line break]* The line breaks there — that's a
144-minute gap where the feed went down. I don't draw across it. And these three ROP numbers
*[point at the performance panel]* — on bottom, overall, and the vendor channel. They're wildly
different, and I'll come back to why.

*[click Anomalies tab]*

51 detected events. Every one shows the numbers it fired on and, where the data is weak, says
so. *[scroll to an overpull event]*

This is the one I'd point at. The daily report for 14 September says, in the driller's own
words, that they found drag at four depths pulling out of hole. This detector never reads that
comment — it only sees hookload — and it independently found three of them, and ranked 3465
feet as the worst. That's the highest hookload in the entire dataset."

---

## MINUTE 2 — architecture and the data decisions (1:00 – 2:00)

> *[click Data quality tab]*

"Now the part I actually spent the time on.

Raw CSVs go through a cleaning and detection pipeline, which writes out processed files. The
API reads those, and the dashboard reads the API. Three dependencies total — Next.js and React.
No chart library, because I needed the charts to show variance and to break on gaps, and most
libraries do neither.

*[point at the findings list]*

Four things in this feed are not what the glossary says.

First — the timestamps only go down to the minute. About 34 readings share each stamp and
there's no seconds field. My assumption, stated plainly: the minute is the smallest unit I'm
allowed to claim. I bucket by the stamp I'm given, keep the row order as-is, and I calculate
every statistic from the real readings inside that minute. I never invent a seconds value.
That matters because the spread inside the minute *is* the stick-slip signal — if you resample
onto a clean 10-second grid first, you've deleted the thing you're looking for.

Second — *[point]* the ROP channel never reads zero. The glossary says zero means not making
hole. If you believe that, the system reports five days of continuous drilling, including a
seven-hour trip. So I work out the state from how the depth, the bit and the blocks move
instead.

Third — the torque sensor reports an exact zero while the string is still turning, on 12% of
readings. RPM doesn't do that, which is how I know it's the sensor, not the rig. Leave those
in and a stick-slip detector alarms 100% of the time.

Fourth — weight on bit reads negative 58% of the time while the bit is definitely cutting rock.
That sensor's mis-calibrated, so I never trust its value, only its steadiness."

---

## MINUTE 3 — 50 rigs in production (2:00 – 3:00)

> *[switch to the API tab, then back]*

"Finally — fifty rigs.

The honest answer is that the throughput isn't the problem. Fifty rigs at this sampling rate is
about two and a half million rows a day. That's a normal day for a single Postgres box with a
time-series extension. Reaching for Kafka and Spark here would be over-engineering by two
orders of magnitude.

Three things do change.

Storage becomes TimescaleDB, and the rollup keeps count, mean, min, max and standard deviation
per minute — *[point at API tab]* exactly the shape this API already returns. If you roll up to
just the mean, you've thrown away the variance at the storage layer, where you can't get it
back.

The detectors barely change — they're already pure functions over a window of minutes. They
move from a batch loop to a stream.

And what actually breaks first is alert fatigue, not compute. Fifty rigs at my current
sensitivity is around 500 events a day and nobody reads that. It needs per-rig baselines —
every threshold I've set is calibrated against this one well — plus deduplication and an
acknowledge path.

But the real lesson from this exercise is that every rig lies differently. One well needed four
separate corrections before I could trust a single number, and none of them were in the
documentation. So the first thing I'd build at scale isn't a bigger pipeline — it's automated
sensor-health monitoring, to catch the next mis-calibrated weight-on-bit sensor before anyone
makes a decision from it."

---

## Delivery notes

- **Speak slower than feels natural.** Panels are engineering leads *and* drilling ops — the
  ops people need to follow this without a technical background, and the script is written for
  them.
- **Don't read the numbers off the screen.** Say the meaning, point at the number.
- **The strongest 15 seconds in the whole video** is the overpull-versus-daily-report match at
  the end of Minute 1. If you only rehearse one passage, rehearse that one.
- Have `docs/BRIEF.md` open in another window — if you blank, the structure is the same.
- If the recording runs to 3:10, that's fine. If it runs to 4:00, cut the DDR assistant and the
  third ROP number.
