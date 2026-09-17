# Glossary — Drilling Terms Used in This Assignment

No prior oil & gas knowledge is needed. Everything referenced in the data pack is defined here.
This version reflects the **real operations data pack** (SEBL_001 / SEBL_002, rigs PHR-05 / PHR-026).

### Telemetry fields (`realtime_rig_telemetry.csv`)

The raw file has **three header rows** before the data starts: a plain-language label, a short sensor code, and a unit. When loading with pandas, skip rows 2–3 after the header row (or treat them as a units/code lookup).

⚠️ **Sampling is irregular, not a clean 10-second grid.** The `dtsrv` timestamp only carries **minute precision** — dozens of readings share the same minute stamp (roughly 30–50 rows per minute, averaging ~37, i.e. one reading every ~1.5–2 seconds). There is no seconds field in the raw feed; ordering within a minute is implied only by row order. Candidates working with this file need to account for that (resampling / cleaning is part of the exercise, not a given).

| Code | Label | Unit | Meaning |
|---|---|---|---|
| `dtsrv` | Date time server | — | Timestamp of the reading (minute precision — see warning above) |
| `DBTM` | Bit Depth | ft | Current depth of the drill bit. Equals `DMEA` while actively drilling; differs when tripping or between depth updates |
| `DMEA` | Hole Depth | ft | How deep the wellbore has been drilled so far |
| `BPOS` | Block Position | ft | Height of the traveling block above the rig floor. Rises/falls as pipe is hoisted or lowered — useful for telling tripping and connections apart from static states |
| `ROP` | Rate of Penetration | ft/h | How fast the bit is cutting new hole. 0 means not currently making new hole (tripping, connection, or stopped) |
| `HKLA` | Hookload | klb | Total weight hanging on the hook (drillstring weight read at surface). A sudden drop can flag a connection, weight being set down, or a more serious event (dropped string) |
| `WOB` | Weight on Bit | klb | Downward force applied to the bit. Near 0 when off-bottom |
| `TORQUE` | Rotary Torque | kft-lb | Rotational force needed to turn the drillstring. Rises with friction/resistance downhole |
| `RPM` | Surface RPM | rpm | Rotary speed measured at surface |
| `SPP` | Standpipe Pressure | psi | Pressure of drilling fluid (mud) being pumped down the drillstring |
| `MFOP` | Mud Flow Out | % | Flow returning at the shale shakers, as a percentage of flow in. Used with `MFIA` to spot losses (MFOP drops while MFIA holds steady) or gains/kicks (MFOP rises above ~100%) |
| `MFIA` | Mud Flow In | gpm | Rate mud is being pumped into the well |

### Operational states
- **Drilling** — bit is on bottom, actively cutting new hole (`ROP` > 0).
- **Tripping** — pipe is being run in or pulled out of the hole without drilling. `ROP` = 0, `BPOS` moving, `HKLA` changing with string weight.
- **Connection** — brief pause to add a new joint of pipe. `ROP` = 0, `BPOS`/`HKLA` momentarily static or spike as pipe is added. Short, planned, recurring.
- **NPT (Non-Productive Time)** — any time that isn't advancing the well as planned. In the DDR file this is captured explicitly via `UNSCHEDULE_EVENT_HRS` and activity codes like `OPSUS` (operations suspended) or `EQRPR` (equipment repair).

### Anomalies to watch for
- **Stick-slip** — the drillstring twists up and releases in a jerky cycle instead of turning smoothly. Shows up as `TORQUE` oscillating rapidly/erratically while `WOB` stays roughly steady. Can damage equipment if sustained. *Note: this signal lives in short-timescale variance — be careful that any downsampling/smoothing of `TORQUE` doesn't erase it (see the resampling notes for the trimmed telemetry file).*
- **Washout** — a leak or hole in the drillstring or bit that lets drilling fluid escape early. Shows up as `SPP` dropping while `MFIA` stays the same.
- **Flow imbalance** — `MFOP` drifting away from ~100% relative to `MFIA` without a matching change in rig state can indicate losses (MFOP drops) or an influx/kick (MFOP rises).

### Daily Drilling Report fields (`daily_drilling_reports.csv`)
The real DDR file is a structured CSV log (568 rows, not JSON), covering two wells (`SEBL_001`, `SEBL_002`) across rigs `PHR-05` / `PHR-026`. Each row is one reported activity block.

| Field | Meaning |
|---|---|
| `FIELDNAME` | Oil field name (e.g. SEBL) |
| `WELLIDE` | Well identifier |
| `RIGNO` | Rig number |
| `DTTMSTART` / `DTTMSTARTCALC` | Start time of this reported activity |
| `DTTMSPUD` | The well's spud date — fixed per well, repeated on every row for that well |
| `WELLPHASE` | Top-level phase: `LOCN` (location/rig move) or `DRLG` (drilling) |
| `PHASE1` | Well-construction phase: `MOB` (mobilization), `SURF` (surface hole), `PRODCSG` (production casing), `PRODLNR1` (production liner) |
| `PHASE2` | Sub-phase, e.g. `MOVEON`, `DRILL`, `CSGCMT` (casing cementing) |
| `ACTIVITY` | Specific operation code — see table below |
| `DURATION` | Hours spent on this activity line (0–19 hrs observed) |
| `UNSCHEDULE_EVENT_HRS` | Hours of unplanned/non-productive time within this line (blank if none — NPT flag) |
| `WBORESZACT` | Actual hole/wellbore size for this activity (e.g. `12.25`, `8.5`, `6 1/8`) |
| `DEPTHACT` | Actual depth (ft) at the end of this report line |
| `COM` | Free-text narrative comment — multi-line, the richest field for an AI/DDR-assistant to summarize or search |

**Common `ACTIVITY` codes seen in the data:** `R/D`/`R/U` (rig down/up), `TIH`/`TOH` (trip in/out of hole), `DRLROT`/`DRLSLD` (rotary/sliding drilling), `DRLDD`/`DRLRS` (directional drilling / rotary steerable), `CSGRUN`/`CMTCSG` (run/cement casing), `BOPTST`/`BOPN/D`/`BOPN/U` (BOP test/nipple down/up), `WOC` (wait on cement), `OPSUS` (operations suspended — NPT), `EQRPR` (equipment repair — NPT), `CC` (circulate), `CLNOUT` (clean out), `FIT` (formation integrity test), `WHDINST`/`WHDTST` (wellhead install/test), `TREETST` (Christmas tree test).

### Offset wells reference (`offset_wells_master.csv`)
This is now a flat **operating-envelope table**, not a per-formation MD/TVD baseline curve.

| Field | Meaning |
|---|---|
| `well_name` | Offset well used as the baseline (e.g. SEBL-001) |
| `Row Labels` | Hole section, named by bit size (e.g. "Drill 12-1/4\" Hole Section") |
| `Max of ROP` / `Max of FLOW_RATE` / `Max of WOB` / `Max of SPPDRILL` / `Max of PU_WEIGHT` / `Max of DRL_TORQUE` | The maximum value historically observed for that parameter while drilling that hole section on the offset well — a rough safe-operating ceiling to compare today's live parameters against for the same hole size |

### Other terms
- **BHA (Bottom Hole Assembly)** — the string of tools directly above the bit (mentioned in DDR narratives).
- **POOH** — "Pull Out Of Hole" — trip the string out of the well, often to inspect or replace equipment after a suspected problem.
- **Offset well** — a previously drilled well nearby, used as a comparison baseline for what "normal" looks like in this field.
