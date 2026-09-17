# Pertamina Drilling Case Study

Five days of drilling-rig sensor data, sampled every couple of seconds (~250,000 rows), analyzed after the fact. Nobody was watching it live. This project builds two things from that data:

1. **A state dashboard** — says what the rig is doing right now in plain terms: Drilling, Sliding, Reaming, Circulating, Tripping In, Tripping Out, Connection, or Static.
2. **A detection system** — scans the same data for looming problems (e.g. stick-slip) instead of waiting for someone to notice.

Plus a stretch piece: a **report-search assistant** that answers questions like "what caused NPT this week" with the real, citable report line.

## The data problem

Raw sensor data can't be trusted at face value:

- **ROP** (drilling speed) never reads exactly zero, so "speed = 0 means not drilling" doesn't hold on this rig.
- **Torque** reports a false zero on ~12% of readings while the pipe is still turning.
- **Weight-on-bit (WOB)** reads negative 58% of the time while the rig is definitely drilling — a sensor calibration fault, not physics.
- **Mud-flow-out (MFOP)** isn't actually the percentage it claims to be.

### How each is handled

| Signal | Approach |
|---|---|
| ROP | Not used for state detection. State comes from whether hole depth is actually increasing, plus bit/block position. A separately computed "real" ROP is shown alongside the sensor's own value for comparison. |
| Torque | Fake zero readings are discarded whenever RPM confirms the pipe is actually spinning, before anything is computed from torque. |
| WOB | Never trusted on its own. Drilling is confirmed from bit depth vs. hole depth instead. For detecting shaky pipe, the *variation* in WOB is used, not its absolute level — that cancels the sensor's constant offset. |
| MFOP | Not compared to a fixed "100%" target. It's flagged only when it drifts from its own recent normal while flow-in stays steady, and those alerts are marked low-confidence pending sensor calibration checks. |

## State classification

Every state is decided from three signals — hole depth increasing, on bottom (hole depth vs. bit depth), and rotating — checked in priority order, top to bottom, stopping at the first match:

- **Drilling** — on bottom, hole depth increasing, rotating.
- **Sliding** — on bottom, hole depth increasing, not rotating (downhole motor pushes the bit while the pipe is held still).
- **Reaming** — not making new hole, bit moving through already-drilled hole, rotating and pumping.
- **Circulating** — not making hole, pumps on, bit essentially stationary.
- **Tripping In / Out** — decided independently of the above: net bit movement of 30+ ft in one direction over a 15-minute window (down = in, up = out).
- **Connection** — bit off bottom, blocks swinging heavily within a single minute (adding/removing a pipe joint).
- **Static** — none of the above.

## The detection system

Runs alongside the state dashboard, scanning the same telemetry for looming problems instead of waiting for someone to notice on the floor:

- **Stick-slip** — the torque signal's variation (once its fake zeros are filtered out) is watched for the oscillation pattern that signals the bit sticking and releasing downhole, flagged only while Drilling/Sliding is confirmed so it isn't triggered by normal off-bottom noise.
- **Sensor-quality faults** — the same checks that clean ROP, torque, WOB, and MFOP for the dashboard are surfaced as their own report, so a fault (like the mis-tared WOB channel) is visible as a data-quality issue in its own right, not just quietly corrected for.
- **Weak connection detection** — flagged deliberately as a known gap rather than hidden (see below), so it's clear which detections can be trusted and which need a human check.

Every flag publishes the exact numbers it fired on — no opaque score, so it can be checked against the raw trace.


## The report-search assistant

Type a question ("what caused NPT this week," "stuck pipe") and get back the actual matching report line with a citation — not a summary.

- **How:** BM25 keyword search — the same ranking approach that powered search before embeddings-based "semantic" search.
- **Why not embeddings:** only 568 report rows, so a full retrieval pipeline is unneeded infrastructure for a lookup that already runs in under a millisecond as a plain scan; drilling questions rely on exact rare tokens (codes, depths) where keyword search beats semantic matching; and citations need to be the literal report line, not a paraphrase. It also needs no API key or internet connection, so a live demo can't fail on stage.
- **The one real gap:** "stuck pipe" won't match a report that says "drag" or "overpull." Patched with a small hand-built synonym glossary readable and editable by a drilling engineer, not just a programmer.

## Why rules, not machine learning

- Five days on one well with no labelled events — nothing to train against, and no honest way to validate a trained model.
- A model fit to this well's quirks (its own sensor offsets, dropout patterns) would memorize noise, not learn drilling.
- An unexplainable flag doesn't get acted on. Every rule-based event here publishes the exact numbers it fired on.
- ML becomes the right call at fleet scale — months of data across many rigs with operator feedback for real labels, and per-rig baselines learned from history.

## Impact

The report booked **73.0 hours** of drilling in this window. The sensors show the bit was actually deepening the hole for **35.5 hours**. The other 37.5 hours are unaccounted for by the report — the core reason to do this from telemetry rather than the paper form.

## If there were one more week

1. Fix the sensors, not just code around them — turn the data-quality checks into a continuously running per-rig sensor-health monitor.
2. Work out where machine learning becomes feasible — sketch what fleet scale would need: months of data across many rigs, operator feedback as real labels, per-rig learned baselines.
3. Work closely with the crew in real time to pin down their actual problem statement, and attribute the unaccounted 37.5 hours (connections, circulating, repairs) against an offset well.
