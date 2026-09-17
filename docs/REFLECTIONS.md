# If I had another week

**1. I would go after the sensor faults instead of working around them.**
I found three in five days on one well — a weight-on-bit channel reading negative 58% of the
time while the bit is demonstrably cutting rock, a torque channel that zero-fills a median 12%
of samples while the string is turning, and a flow-out channel that isn't the unit it claims to
be. I coded around all three. That's the right call under a four-hour budget and the wrong call
permanently, because a mis-tared weight-on-bit sensor doesn't only mislead a dashboard, it
misleads the driller at the brake. I'd turn `/api/quality` from a one-off report into a
continuously running per-rig sensor-health monitor: cross-check every channel against the ones
that should corroborate it, and raise "rig 34's WOB has read 10 klb low since Tuesday" as its
own alert. On a fleet that's probably worth more than the anomaly detection, because it's
certain, actionable, and silently corrupting every other number.

**2. I would ask for 1 Hz torque and find out whether the stick-slip detector is actually
right.**
Right now I can't fully defend it. A real stick-slip cycle runs 1–10 seconds; this feed samples
every 1.7. That's the edge of Nyquist, so the signal is aliased — which is why I publish a
relative severity index at MEDIUM confidence rather than a stick-slip percentage, and say so on
every event. That's an honest limitation, not a solved problem, and no amount of better
algorithm fixes it — it needs faster data. With a week I'd get a higher-rate torque feed for a
few shifts, run both side by side, and find out whether my index tracks true severity or just
correlates with it. I'd also sit with a driller and label a few hundred minutes, which is the
only way to get a real false-positive rate instead of the plausible-looking thresholds I
calibrated off this well's own distribution.

**3. I would make it answer "so what", not just "what".**
The system currently reports that the bit was deepening the hole for 35.5 of the 73 hours the
reports book as drilling. That's a genuinely interesting number and it stops one step too
early. The useful version attributes the other 37.5 hours — this much to connections, this much
to circulating, this much to a pump repair — then benchmarks each against the offset well and
puts hours and cost against the gap. That turns a monitoring tool into a performance tool, and
it's the version a drilling superintendent would open every morning. It mostly needs joining
work I've already done, not new detection: the state timeline, the activity codes and the
offset envelope are all in there and already lined up on the same clock.
