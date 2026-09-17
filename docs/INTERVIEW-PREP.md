# Interview prep

Not part of the deliverable — this is for you. It explains every decision in the repo in plain
language, and works through the questions a panel is likely to ask.

**Ground rule for the whole interview: never claim you wrote code you didn't, and never bluff a
detail you don't have.** The brief explicitly allows AI tooling and says they're assessing
judgment and outcome. The strongest possible position is *"I directed the work and I can defend
every decision in it"* — which is true, and which you can demonstrate. The fastest way to lose
is to guess at an implementation detail and be wrong. "I'd have to look at that file" is a
completely acceptable answer and costs you nothing.

---

## The 60-second version, if they ask you to summarise

> "It's a dashboard and an API over five days of telemetry from SEBL_002. It tells you what the
> rig is doing — drilling, tripping, connection — and flags stick-slip, overpull and washout.
>
> But most of my time went into the data, not the features. Four channels in that feed don't
> behave the way the glossary describes, and each one breaks the obvious approach. The clearest
> example: the glossary says ROP of zero means you're not making hole. In this file ROP never
> reaches zero — so if you follow the documentation, your system reports five days of
> continuous drilling including a seven-hour trip out of the hole.
>
> The thing I'm most pleased with is that the overpull detector independently reproduced drag
> depths that the driller had written down in free text, from sensor data alone."

---

## The core concepts, in plain language

**Hole depth vs bit depth.** Hole depth is how deep the well has been drilled. Bit depth is
where the drill bit currently is. When you're drilling they're the same. When you pull the pipe
out, the hole stays deep and the bit comes up — so the gap between them tells you the bit is
off bottom. That gap is what I use for "is the bit on bottom", and it's reliable, unlike the
weight-on-bit sensor.

**Why ROP never reaching zero matters.** ROP is "rate of penetration" — how fast you're cutting
new rock. It should be zero when you're not drilling. In this file it never drops below 0.02
and sits around 1–3 even during trips, because it's a smoothed number the vendor's system
calculates, not a raw measurement. So I ignore it for classification and compute my own rate
from how the hole depth actually changes.

**Stick-slip.** The drillpipe is a very long steel spring. Sometimes the bit catches, the pipe
winds up like a torsion spring, then releases and spins free — over and over. It wrecks
equipment. At surface you see it as torque swinging up and down while the weight on the bit
stays steady.

**Why the torque zeros are the crux.** For 72% of the minutes where the rig is rotating, the
torque channel reports an exact 0 on some readings — median 12% of them. If the string had
really stopped, RPM would also read zero. It doesn't; it only shows that pattern in 4.8% of
those minutes. So it's a sensor dropout. **That comparison between the two channels is the
whole argument** — it's how I know it's the sensor and not the rig. If you leave those zeros
in, torque looks like it's swinging from 0 to 4000 every single minute, and a stick-slip
detector based on variance alarms constantly and is wrong every time.

**Why I use MAD instead of standard deviation.** Standard deviation squares the differences, so
one wild outlier dominates it. Median absolute deviation uses the middle value instead, so
outliers barely move it. Even after removing the exact zeros, the torque channel still has
occasional spikes — so I need the measure that ignores them. Say it like this: *"standard
deviation would mostly be measuring the leftover sensor glitches, not the drilling."*

**Aliasing / Nyquist.** To see a wave you have to sample at least twice per cycle. Stick-slip
cycles take 1–10 seconds and this feed samples every 1.7 seconds. So for the fast cycles I'm
right at the limit and can't resolve them properly. That's why I call my output a *relative
severity index* and not a stick-slip percentage — I can rank which minutes are worse, but I
can't tell you the true cycle frequency. **Volunteer this limitation.** It's the single
strongest signal of judgment in the whole project.

**Overpull.** Pulling pipe out, the hook carries the string's weight — about 145,000 lb here.
If it snags, you have to pull harder, and the hookload spikes above normal. That's an early
warning for stuck pipe, which is one of the most expensive things that happens on a rig.

**BM25.** A keyword search ranking formula. It favours words that are rare across the whole
collection and penalises very long documents so they don't win just by being long.

---

## Likely questions

### "Walk me through how you decided what the rig was doing."

> "I don't use the ROP channel, because it never reads zero in this file. I use three physical
> things: whether hole depth is increasing — that's the only unambiguous proof new rock was
> cut; the gap between hole depth and bit depth, which tells me if the bit's on bottom; and how
> the bit and the blocks are moving.
>
> One wrinkle: the depth channels update in steps rather than smoothly — about 8% of minutes
> inside a clearly-advancing stretch report zero change. So I judge 'making hole' over a
> centred seven-minute window instead of minute by minute. Minute by minute, a continuous
> drilling interval shatters into confetti, and that's an artefact of the sensor update rate,
> not anything happening on the rig."

### "Your agreement with the DDR is only 61%. Isn't that bad?"

This is the question most likely to be used to test you. **Do not get defensive.**

> "I'd push back on reading it as an accuracy score. The DDR is a coarse envelope — a line
> saying 'trip in hole, 8 hours' covers the circulating breaks and connections inside that
> trip, which the sensors resolve at minute scale and the paperwork rounds off. So a chunk of
> that 39% is my detector being *more* precise than the thing it's being compared to.
>
> I deliberately didn't tune it upward, because optimising toward the paperwork would mean
> making the detector blunter on purpose.
>
> Where it should be high, it is: equipment repair 95%, surface equipment testing 100%,
> tripping out 74%. Where it's genuinely weak is circulating, at 28% — and I know why. When
> they circulate they also work the pipe up and down to stop it sticking, so the bit really is
> moving and my logic reads it as a short trip. That one's a real limitation and it's in the
> README."

### "Why rules instead of machine learning?"

> "Two reasons. Five days of one well with no labelled events isn't enough to train anything
> that generalises — I'd be fitting noise and I'd have no honest way to validate it.
>
> The second reason matters more operationally. On a rig, a flag nobody can explain is a flag
> nobody acts on. Every event here publishes the exact numbers it fired on, so a driller can
> disagree with it on the evidence. That's what makes it usable.
>
> Where ML does become right is at fleet scale — once you've got months across fifty rigs with
> operator feedback, you have labels, and then per-rig baselines learned from history beat my
> hand-set thresholds."

### "How do you know your anomaly detection actually works?"

**This is your best question. Make sure it gets asked or bring it up yourself.**

> "The daily report for 14 September says in free text that the crew found drag of 10 to 12
> thousand pounds at four depths while pulling out. My overpull detector only looks at
> hookload — it never reads that comment field. It independently flagged three of those four
> depths, and ranked 3465 feet as the worst, with hookload peaking at 172,700 pounds. That's
> the highest hookload anywhere in the five days.
>
> Then it goes further. All four of those depths had high torque oscillation detected while
> drilling *down* through them earlier. So you've got two independent sensor signals and a
> human note agreeing — tight formation going in, drag coming out, same depths — and none of
> them knew about the others."

### "What was the hardest bug?"

> "The overpull detector originally missed the biggest event in the file. I'd gated it on
> minutes classified as 'tripping out', which sounds right. But when a string is genuinely
> stuck, the blocks stop moving while the driller pulls against it — so bit depth stops
> changing, my state machine correctly says 'static', and the detector skipped exactly the
> minute that mattered. The harder the string is stuck, the more certainly it was missed.
>
> The fix is that it now scores across the whole trip-out episode rather than minute-by-minute
> state. I only caught it because I was checking my results against the driller's written
> notes and one of the depths they named wasn't in my output."

### "Why didn't you use pandas / a chart library / a vector database?"

> "Different answer for each.
>
> No chart library because every series here carries a min–max band and a standard deviation —
> the spread is the signal. A default line chart plots the mean and discards the rest, and most
> libraries will cheerfully draw a straight line across a 144-minute gap in the feed. I needed
> the band drawn and the line broken, so I wrote the SVG.
>
> No vector database because the corpus is 568 rows. A vector index exists to make similarity
> search sublinear at scale; at this size it's a dependency and a model download to speed up a
> scan that takes under a millisecond. And these questions are full of exact rare tokens —
> depths, codes like EQRPR, tool names — which is exactly where dense retrieval does worse than
> keyword search.
>
> On stack generally: the whole thing has three runtime dependencies and zero npm audit
> vulnerabilities. That was deliberate."

### "How much of this did AI write?"

Answer this straight and without embarrassment — the brief explicitly permits it.

> "I used AI coding tools throughout, which the brief allows. What I brought was the direction
> and the judgment: deciding to profile every channel before writing a line of application
> code, spotting that the ROP channel never zeroes and that the glossary rule therefore had to
> be abandoned, choosing to validate the state machine against the DDR instead of just
> asserting it worked, and deciding to publish confidence and caveats on events rather than
> hiding the weak signals.
>
> I can walk you through any decision in the repo and tell you what the alternative was and why
> I rejected it. That's the part that's mine."

If pushed on whether you can code: be honest that your background is UI/UX and you're moving
into this. Then point at the judgment calls — those are what the scorecard actually measures,
and they're genuinely yours.

### "What would you do differently?"

> "I'd have set up the validation against the DDR earlier. I built the state machine first and
> checked it afterwards, and the check immediately exposed two bugs — connections being read as
> short trips, and the stuck-pipe gating problem. If I'd had that harness from the start I'd
> have caught both in the first hour instead of the third."

### "What's the weakest part?"

Have this ready. Volunteering a weakness before they find it is worth a lot.

> "Connection detection. I find about 1.7 hours of connections across 3,563 feet of hole, which
> is clearly too low — you make a connection every 90 feet or so. On this rig the flow channel
> often stays high right through a connection, so the textbook 'pumps off' signature doesn't
> hold, and I haven't found a clean replacement. I left the number honest rather than tuning
> until it looked right.
>
> Second weakest is the flow-imbalance detector. It's implemented but it found nothing, and I
> can't fully trust it because that channel isn't the unit the glossary claims."

---

## If a demo fails live

The whole thing runs offline with no API key. If something does break:

- **Dashboard won't start** → `npm run build` then `npm start`. The ETL runs inside the build.
- **Port 3000 busy** → `npx next start -p 3001`.
- **DDR assistant returns nothing** → it's keyword search; try an activity code like `EQRPR` or
  a well name. Leave the "LLM summary" toggle **off** — it needs an API key and the default
  answer is the one built from retrieval anyway.

Don't debug live. Say "let me come back to that" and move to the next thing.

---

## Numbers worth memorising

| | |
|---|---|
| Rows / minutes | 249,395 → 7,330 |
| Window | 9–14 Sep 2026, SEBL_002 / PHR-026 |
| Footage | 3,562.9 ft (795 → 4,062 ft) |
| Measured / missing | 122.2 h / 5.9 h |
| On bottom | 35.5 h — vs 73.0 h of drilling booked in the DDR (49%) |
| ROP on bottom / overall / vendor channel | 100.3 / 29.2 / 3.14 ft/hr |
| Feed gaps | 46, totalling 351 min, largest 144 min |
| Events detected | 51 (22 overpull, 20 stick-slip, 8 envelope, 1 washout) |
| Biggest overpull | 28.8 klb at 3465 ft — peak hookload 172.7 klb, highest in the file |
| DDR agreement | 60.8% over 7,285 minutes |
| Torque zero-fill | median 12% of samples, in 72% of rotating minutes |
| WOB negative while drilling | 58% of 881 confirmed drilling minutes |

**If you remember only one thing:** the reports book 73 hours of drilling; the sensors say the
bit was actually deepening the hole for **35.5** of them - 49%.
