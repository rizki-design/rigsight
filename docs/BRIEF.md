# Brief

**RigSight — drilling telemetry dashboard and anomaly-detection API**
Rizkiaji Putro · SEBL_002 / rig PHR-026 · five days of data, 9–14 September

## What I built

A dashboard that shows what the rig is doing and flags when something is going wrong, plus the
API underneath it. I covered the main item from both tracks. That sounds like twice the work,
but the two share one engine: an API over cleaned, state-classified telemetry and a dashboard
displaying cleaned, state-classified telemetry are the same job done once. The expensive part —
understanding the feed well enough to trust a number from it — was shared. I led with the
backend lens and built the dashboard on top.

## What I actually spent the time on

Not features. Reading the data properly. Four things in the feed are not what the documentation
says, and each one breaks an obvious approach:

- **The ROP channel never reaches zero.** It sits at 1–3 ft/hr through trips and connections.
  The glossary says "ROP = 0 means not making hole" — follow that and the system reports five
  straight days of drilling, including a seven-hour trip out of the hole. So I work out what
  the rig is doing from how the hole depth, the bit and the blocks actually move.
- **The torque sensor drops to zero while the string is still turning** — a median 12% of
  readings, in 72% of the minutes the rig is rotating. The RPM sensor doesn't do this, which is
  how I know it's the sensor and not the string stopping. Leave those zeros in and a stick-slip
  detector alarms 100% of the time, every one a false alarm.
- **The weight-on-bit sensor is mis-calibrated.** During 881 minutes where the bit is
  demonstrably cutting rock, it reads negative 58% of the time. So I never trust its value,
  only its steadiness.
- **The mud flow-out channel isn't the percentage the glossary describes.** It should sit near
  100 and instead sits at 20.

The feed also only timestamps to the minute — about 34 readings share each stamp, with no
seconds. I treat the minute as the smallest unit I'm allowed to claim, keep every reading
inside it, and calculate the spread from the real samples. That spread *is* the stick-slip
signal, so anything that smooths it first has thrown away what it was built to find. I don't
draw lines across the 46 gaps in the feed either — including one 144-minute blackout.

## Does it work?

The best evidence isn't a chart. The daily report for 14 September says in plain text that the
crew found drag at four depths while pulling out. My overpull detector, which never reads that
comment, independently found three of them from the sensors alone — and ranked 3465 ft as the
worst, which turns out to be the highest hookload in the entire five days. Every one of those
four depths also showed high torque oscillation while drilling *down* through it. Two sensor
signals and a human note, agreeing, none of them aware of the others.

I also check the state detection against the driller's own activity codes: 61% agreement. I
deliberately did not tune that higher, because a report line saying "trip in, 8 hrs" includes
the pauses inside that trip which the sensors can see and the paperwork rounds off. Much of the
disagreement is the detector being more precise than the thing it's compared against.

## What I left out on purpose

No machine learning — five days of one well with no labelled events can't train anything that
generalises, and on a rig a flag nobody can explain is a flag nobody acts on. No vector
database for the report search — 568 rows don't need one, and these questions are full of exact
codes and depths, which plain keyword search handles better. No live streaming, because this is
a historical export; I present it as a replay rather than pretend otherwise. Connection
detection is the weakest part and I've said so rather than tuning until the number looked
right.

## The one number to take away

The reports book **73 hours** of drilling in this window. The sensors say the bit was actually
deepening the hole for **35.5** of them - 49%. That gap is the whole reason to do this from
telemetry rather than from the form.
