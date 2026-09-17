# Take-Home Technical Assignment
## Real-Time Drilling Digitalization & AI Assistant

### 1. Overview

You're joining the Drilling Engineering Digitalization team's evaluation stage. The team turns raw drilling telemetry, operational logs, and workflow data into digital tools — dashboards, AI-assisted apps, and performance tracking. No prior oil & gas experience is assumed; a glossary is included, and drilling logic in the data is explained in plain terms where it matters.

This data pack is built from **real (anonymized) operations data** — it is messier than a synthetic dataset on purpose. Reading and cleaning it correctly is part of what we're evaluating.

### 2. Time & Tools

- **Delivery:** you'll receive this pack the morning before your interview (~7:00 AM), one day ahead. Use the daytime to read through the pack and glossary at your own pace — most candidates are working, so we don't expect you to start immediately.
- **Working time:** budget 3-4 focused hours to actually build. Do not spend more than 4 — we'd rather see a well-scoped core item than a rushed everything. When you sit down to build is up to you (that evening works fine).
- **AI coding tools encouraged** (Cursor, Copilot, v0, LLM APIs, etc.) — we're evaluating judgment and outcome, not how much code you typed by hand.
- **Stack:** your choice (Python, TypeScript, Node.js, Next.js, FastAPI, Streamlit, React, etc.)

### 3. Provided Data Package

1. `realtime_rig_telemetry.csv` — real sensor feed, sampled irregularly (roughly every 1.5–2 seconds, averaging ~37 readings/minute). **The timestamp column only carries minute precision** — expect to make and state an assumption about ordering within a minute. Fields: `dtsrv, DBTM, DMEA, BPOS, ROP, HKLA, WOB, TORQUE, RPM, SPP, MFOP, MFIA` (see glossary for what each code means). The file has 3 header rows (label / code / unit).
   - **You do not need to build an elegant resampling pipeline for this.** A simple, clearly-stated approach — e.g. "I bucketed by the given minute and treated within-minute row order as-is" — is a perfectly acceptable, non-penalized choice. The bar is *awareness and a stated assumption*, not sophistication. Don't let this eat your 3-4 hours.
2. `daily_drilling_reports.csv` — structured operations log (568 rows, two wells, two rigs), with coded phase/activity fields plus a free-text `COM` narrative field per line.
3. `offset_wells_master.csv` — historical maximum-parameter table per hole section, used as a rough safe-operating ceiling for comparison.
4. `glossary.md` — plain-language definitions of every field and code used above, including the telemetry sampling caveat.

### 4. Pick One Track

Both tracks share the same data package.

**Core requirement (must complete):** pick ONE of the two items marked *Core* in your track. **Stretch (attempt only if time remains):** the other item(s). We'd rather see one thing done well than three things done shallowly — partial/stretch work is a bonus, not a requirement.

#### Track A: Product / Full-Stack

- *Core:* **Interactive Dashboard** — key telemetry trends (Depth vs. Time, ROP vs. WOB) plus an **Operational State Display**: is the rig currently Drilling / Tripping / in a high-torque alert state, computed from the data. Since the raw feed is irregularly sampled, state clearly how you handled/cleaned the timestamps before charting.
- *Stretch:* **AI DDR Assistant** — a chat widget answering questions over `daily_drilling_reports.csv` (e.g. "summarize torque spikes on night shift", "what caused NPT on SEBL_002"), reasoning over both the coded fields and the free-text `COM` field.

#### Track B: Backend / AI

- *Core:* **Time-Series API** — serve aggregated calculations (progress, avg ROP per interval) PLUS an **Anomaly Detector**: rule-based or ML logic flagging risks like stick-slip (high torque variance) or washouts (SPP drop without flow change). Note: `TORQUE` variance is the stick-slip signal — if you resample/smooth the feed, explain how you preserved that signal rather than averaging it away.
- *Stretch:* **RAG Search over DDR logs** — index `daily_drilling_reports.csv` (treat `COM` as the searchable text, other columns as metadata/filters) into a local vector/structured store with a `POST /query` endpoint returning source citations.

You may blend tracks if that's genuinely your instinct — tell us which lens you led with.

### 5. Deliverables

1. **GitHub repo** — clean, public, with a `README.md` covering local setup
2. **Video walkthrough (Loom/Vimeo, 3 min max):**
   - Min 1 — the app/API running
   - Min 2 — architecture and data-flow decisions (including how you handled the telemetry's irregular timestamps)
   - Min 3 — how you'd scale this for 50 rigs streaming simultaneously in production
3. **Half-page brief** (plain language, no jargon) — what you built, what you deliberately left for stretch/cut, and why
4. **3 bullets:** "if I had another week, I'd..."

### 6. Evaluation Scorecard

For the panel (mix of engineering leads and drilling ops, no IT background required to score this):

| Criterion | What to look for |
|---|---|
| Problem understanding | Did the core deliverable solve a real question a drilling engineer would ask? |
| Data handling | Did they notice the messiness in the real feed (irregular timestamps, no seconds field) and state a clear assumption, rather than silently assuming clean 10s intervals? Sophistication isn't required — awareness is |
| Craftsmanship | Is the core item solid, not just present? |
| Judgment under constraint | Did they scope sensibly for 3-4 hrs, and explain tradeoffs clearly? |
| AI usage | Did AI tooling produce a clean result, or messy/unreviewed output? |
| Communication | Could you follow the video/brief without asking a technical follow-up? |

Not scored: raw feature count, visual polish, or drilling-domain fluency beyond what the glossary provides.

### 7. Submission

Send repo link + video + brief to [contact/link] by [deadline]. Come to the interview ready to walk through your decisions live.
