"use client";

import { useState, useMemo, useCallback, useDeferredValue, useEffect, type Dispatch, type SetStateAction } from "react";
import { TimeSeries, StateRibbon, Scatter, EnvelopeBar, fmtStamp, fmtDay, PAD, type Pt } from "./charts";
import { DdrAssistant } from "./assistant";
import type { ClientPayload, Cockpit } from "@/lib/payload";

export const STATE_COLORS: Record<string, string> = {
  DRILLING: "var(--drilling)",
  SLIDING: "var(--sliding)",
  TRIPPING_IN: "var(--tripping-in)",
  TRIPPING_OUT: "var(--tripping-out)",
  CONNECTION: "var(--connection)",
  CIRCULATING: "var(--circulating)",
  REAMING: "var(--reaming)",
  STATIC: "var(--static)",
  NO_DATA: "var(--nodata)",
};

const STATE_LABEL: Record<string, string> = {
  DRILLING: "Drilling",
  SLIDING: "Sliding",
  TRIPPING_IN: "Tripping in",
  TRIPPING_OUT: "Tripping out",
  CONNECTION: "Connection",
  CIRCULATING: "Circulating",
  REAMING: "Reaming",
  STATIC: "Static",
  NO_DATA: "No data",
};

const SEV_COLOR: Record<string, string> = {
  WATCH: "var(--watch)",
  WARN: "var(--warn)",
  ALARM: "var(--alarm)",
};

type Tab = "overview" | "telemetry" | "anomalies" | "quality" | "assistant";

// Hidden for now - confusing without someone to walk through what it means. Flip
// back to true to bring the ROP vs WOB scatter back.
const SHOW_ROP_WOB = false;

export default function Dashboard({ data }: { data: ClientPayload }) {
  const [tab, setTab] = useState<Tab>("overview");
  // The cursor is the "now" of the replay. Historical data played back against a
  // scrubber is the honest framing - this is a five-day export, not a live feed, and
  // pretending otherwise would be the first thing a drilling engineer caught. Starts
  // at the beginning so the scrubber sits where Play expects to start from.
  const [cursorIdx, setCursorIdx] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  const deferredIdx = useDeferredValue(cursorIdx);
  const current = data.cockpit[deferredIdx];
  const cursorT = current?.[0] ?? data.meta.to;
  // The header (readouts + the stick-slip banner) previews whatever moment is under
  // the mouse, not just the committed scrub position - otherwise hovering over a red
  // alarm line on the chart would move the preview cursor there but never show the
  // alert it belongs to.
  const previewCurrent = hover !== null ? data.cockpit[nearestCockpitIndex(data.cockpit, hover)] : current;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <Header data={data} current={previewCurrent} />

      <nav className="sticky top-0 z-20 border-b" style={{ background: "var(--bg)", borderColor: "var(--line)" }}>
        <div className="mx-auto max-w-[1400px] px-4 flex gap-1 overflow-x-auto">
          {(
            [
              ["overview", "Overview"],
              ["telemetry", "Telemetry"],
              ["anomalies", `Anomalies (${data.anomalies.length})`],
              ["quality", `Data quality (${data.quality.length})`],
              ["assistant", "DDR assistant"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className="px-3 py-2.5 text-[13px] whitespace-nowrap border-b-2 -mb-px transition-colors"
              style={{
                borderColor: tab === k ? "var(--accent)" : "transparent",
                color: tab === k ? "var(--text)" : "var(--muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-[1400px] px-4 py-4 space-y-4">
        {tab === "overview" && (
          <Overview
            data={data}
            current={current}
            cursorT={cursorT}
            cursorIdx={cursorIdx}
            setCursorIdx={setCursorIdx}
            hover={hover}
            setHover={setHover}
          />
        )}
        {tab === "telemetry" && <Telemetry data={data} cursorT={cursorT} setCursorIdx={setCursorIdx} hover={hover} setHover={setHover} />}
        {tab === "anomalies" && <Anomalies data={data} />}
        {tab === "quality" && <Quality data={data} />}
        {tab === "assistant" && <DdrAssistant meta={data.meta} />}
      </main>

      <footer className="mx-auto max-w-[1400px] px-4 py-6 text-[11px]" style={{ color: "var(--dim)" }}>
        RigSight - built for the Drilling Engineering Digitalization case study. All timestamps are rig local time as
        supplied; the source feed carries no timezone marker, so none is assumed.
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Header + Operational State Display                                  */
/* ------------------------------------------------------------------ */

function Header({ data, current }: { data: ClientPayload; current: Cockpit }) {
  const state = current?.[1] ?? "NO_DATA";
  const color = STATE_COLORS[state];

  // The high-torque alert the brief asks for. It is deliberately not "torque is
  // high": torque is supposed to be high while drilling hard. What matters is torque
  // swinging, which is the stick-slip signature. Driven by the same recorded
  // STICK_SLIP/ALARM events the red lines on the depth chart come from, rather than
  // a live threshold on its own - otherwise scrubbing through a marked event could
  // show no banner just because that exact minute dipped under an arbitrary cutoff.
  const disp = current?.[11] ?? null;
  const t = current?.[0];
  const activeStickSlip = useMemo(
    () =>
      t === undefined
        ? undefined
        : data.anomalies.find((a) => a.type === "STICK_SLIP" && a.severity === "ALARM" && t >= a.from && t <= a.to),
    [data.anomalies, t],
  );
  const torqueAlert = !!activeStickSlip;

  return (
    <header className="border-b" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
      <div className="mx-auto max-w-[1400px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold tracking-tight">{data.meta.well}</span>
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
                replay
              </span>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
              rig {data.meta.rig} &middot; {data.meta.field} field
            </div>
          </div>

          <div className="flex items-center gap-3 px-4 py-2 rounded-lg" style={{ background: "var(--panel-2)" }}>
            <span className="relative flex h-2.5 w-2.5">
              <span className="live-dot absolute inline-flex h-full w-full rounded-full" style={{ color }} />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: color }} />
            </span>
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--dim)" }}>
                Rig state
              </div>
              <div className="text-[17px] font-semibold leading-tight" style={{ color }}>
                {STATE_LABEL[state] ?? state}
              </div>
            </div>
          </div>

          {torqueAlert && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg border"
              style={{ borderColor: "var(--alarm)", background: "rgba(244,63,94,0.10)" }}
            >
              <span className="text-[14px]" style={{ color: "var(--alarm)" }}>
                &#9888;
              </span>
              <div>
                <div className="text-[12px] font-semibold" style={{ color: "var(--alarm)" }}>
                  High torque oscillation
                </div>
                <div className="text-[10px] tabular" style={{ color: "var(--muted)" }}>
                  dispersion index {disp !== null ? disp.toFixed(2) : "--"} &middot; stick-slip signature
                </div>
              </div>
            </div>
          )}

          <div className="ml-auto text-right">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--dim)" }}>
              Replay position
            </div>
            <div className="text-[13px] tabular">{fmtStamp(current?.[0] ?? data.meta.to)}</div>
          </div>
        </div>

        <ReadoutRow current={current} />
      </div>
    </header>
  );
}

function ReadoutRow({ current }: { current: Cockpit }) {
  const cells: { label: string; value: string; unit: string; hint?: string }[] = [
    { label: "Hole depth", value: fmtNum(current?.[2]), unit: "ft" },
    { label: "Bit depth", value: fmtNum(current?.[3]), unit: "ft" },
    { label: "ROP", value: fmtNum(current?.[4], 1), unit: "ft/hr", hint: "measured from hole-depth change, not the vendor channel" },
    { label: "WOB", value: fmtNum(current?.[5], 1), unit: "klb", hint: "sensor has a zero-offset fault - see Data quality" },
    { label: "Torque", value: fmtNum(current?.[6], 0), unit: "ft-lb" },
    { label: "RPM", value: fmtNum(current?.[7], 0), unit: "rpm" },
    { label: "SPP", value: fmtNum(current?.[8], 0), unit: "psi" },
    { label: "Flow in", value: fmtNum(current?.[9], 0), unit: "gpm" },
    { label: "Hookload", value: fmtNum(current?.[10], 1), unit: "klb" },
  ];

  return (
    <div className="mt-3 grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-px rounded-lg overflow-hidden" style={{ background: "var(--line)" }}>
      {cells.map((c) => (
        <div key={c.label} className="px-2.5 py-2" style={{ background: "var(--panel-2)" }} title={c.hint}>
          <div className="text-[9px] uppercase tracking-wider truncate" style={{ color: "var(--dim)" }}>
            {c.label}
            {c.hint && <span style={{ color: "var(--watch)" }}> *</span>}
          </div>
          <div className="text-[15px] tabular leading-tight mt-0.5">
            {c.value}
            <span className="text-[9px] ml-1" style={{ color: "var(--dim)" }}>
              {c.unit}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

const fmtNum = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined ? "--" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// Timestamps are naive rig-local time rendered through toISOString() (see fmtDay/fmtClock
// in charts.tsx), so a "day" is a UTC calendar day - this stays consistent with that.
const DAY_MS = 86_400_000;
const dayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/** Index of the cockpit row closest to t - cockpit is sorted ascending by timestamp. */
function nearestCockpitIndex(cockpit: Cockpit[], t: number): number {
  let lo = 0;
  let hi = cockpit.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cockpit[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(cockpit[lo - 1][0] - t) <= Math.abs(cockpit[lo][0] - t)) return lo - 1;
  return lo;
}

/**
 * Day + operational-state filtering, shared by every tab that shows the depth/
 * telemetry charts against the state ribbon. Empty set = no filter = everything shown.
 */
function useDayStateFilter(data: ClientPayload) {
  const dayKeys = useMemo(() => {
    const out: number[] = [];
    for (let d = dayStart(data.meta.from); d <= data.meta.to; d += DAY_MS) out.push(d);
    return out;
  }, [data.meta.from, data.meta.to]);
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set());
  const toggleDay = (d: number) =>
    setSelectedDays((prev) => {
      const next = new Set(prev);
      next.has(d) ? next.delete(d) : next.add(d);
      return next;
    });

  const stateByMinute = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of data.cockpit) m.set(c[0], c[1]);
    return m;
  }, [data.cockpit]);
  const [selectedStates, setSelectedStates] = useState<Set<string>>(new Set());
  const toggleState = (st: string) =>
    setSelectedStates((prev) => {
      const next = new Set(prev);
      next.has(st) ? next.delete(st) : next.add(st);
      return next;
    });

  const viewWindow = useMemo(() => {
    if (selectedDays.size === 0) return { from: data.meta.from, to: data.meta.to };
    const keys = [...selectedDays];
    return { from: Math.min(...keys), to: Math.min(Math.max(...keys) + DAY_MS, data.meta.to) };
  }, [selectedDays, data.meta.from, data.meta.to]);

  // Crop to the picked days, then null out (not remove) any point inside that window
  // whose day or operational state wasn't picked - so an excluded stretch breaks the
  // line instead of bridging across it, same rule the feed gaps follow.
  const maskSeries = useCallback(
    (points: Pt[]): Pt[] =>
      points
        .filter((p) => p.t >= viewWindow.from && p.t <= viewWindow.to)
        .map((p) => {
          const dayOk = selectedDays.size === 0 || selectedDays.has(dayStart(p.t));
          const stateOk = selectedStates.size === 0 || selectedStates.has(stateByMinute.get(p.t) ?? "");
          return dayOk && stateOk ? p : { ...p, mean: null, min: null, max: null, sd: null };
        }),
    [viewWindow, selectedDays, selectedStates, stateByMinute],
  );

  const viewSpans = useMemo(
    () => (selectedDays.size === 0 ? data.spans : data.spans.filter((sp) => selectedDays.has(dayStart(sp.from)))),
    [data.spans, selectedDays],
  );
  const viewStateMinutes = useMemo(() => {
    if (selectedDays.size === 0) return data.stateMinutes;
    const out: Record<string, number> = {};
    for (const sp of viewSpans) {
      const mins = (Math.min(sp.to, viewWindow.to) - Math.max(sp.from, viewWindow.from)) / 60_000;
      if (mins > 0) out[sp.state] = (out[sp.state] ?? 0) + mins;
    }
    return out;
  }, [data.stateMinutes, viewSpans, selectedDays, viewWindow]);

  // Dims every state block except the ones picked, so a state filter reads as "spotlight
  // this state on the ribbon" rather than just silently breaking the charts below it.
  const ribbonColors = useMemo(() => {
    if (selectedStates.size === 0) return STATE_COLORS;
    const out: Record<string, string> = {};
    for (const k of Object.keys(STATE_COLORS)) out[k] = selectedStates.has(k) ? STATE_COLORS[k] : "var(--nodata)";
    return out;
  }, [selectedStates]);

  return {
    dayKeys,
    selectedDays,
    setSelectedDays,
    toggleDay,
    selectedStates,
    setSelectedStates,
    toggleState,
    viewWindow,
    maskSeries,
    viewSpans,
    viewStateMinutes,
    ribbonColors,
  };
}

function FilterChip({ active, activeColor = "var(--accent)", onClick, children }: { active: boolean; activeColor?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors"
      style={{
        borderColor: active ? activeColor : "var(--line)",
        color: active ? "var(--text)" : "var(--muted)",
        background: active ? "rgba(255,255,255,0.06)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

/** Days-picked + state-picked filter row, shared by every tab with charts against the ribbon. */
function DaysFilterRow({
  dayKeys,
  selectedDays,
  setSelectedDays,
  toggleDay,
}: {
  dayKeys: number[];
  selectedDays: Set<number>;
  setSelectedDays: Dispatch<SetStateAction<Set<number>>>;
  toggleDay: (d: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-2">
      <span className="text-[10px] uppercase tracking-wider mr-0.5" style={{ color: "var(--dim)" }}>
        Days
      </span>
      <FilterChip active={selectedDays.size === 0} onClick={() => setSelectedDays(new Set())}>
        All
      </FilterChip>
      {dayKeys.map((d) => (
        <FilterChip key={d} active={selectedDays.has(d)} onClick={() => toggleDay(d)}>
          {fmtDay(d)}
        </FilterChip>
      ))}
    </div>
  );
}

/** Sits directly under the state ribbon it filters, same spot the plain legend used to be. */
function StatesFilterRow({
  selectedStates,
  setSelectedStates,
  toggleState,
  viewStateMinutes,
}: {
  selectedStates: Set<string>;
  setSelectedStates: Dispatch<SetStateAction<Set<string>>>;
  toggleState: (s: string) => void;
  viewStateMinutes: Record<string, number>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-[46px] text-[10px]">
      <span className="uppercase tracking-wider mr-0.5" style={{ color: "var(--dim)" }}>
        States
      </span>
      <FilterChip active={selectedStates.size === 0} onClick={() => setSelectedStates(new Set())}>
        All
      </FilterChip>
      {Object.entries(STATE_LABEL)
        .filter(([k]) => viewStateMinutes[k])
        .sort((a, b) => (viewStateMinutes[b[0]] ?? 0) - (viewStateMinutes[a[0]] ?? 0))
        .map(([k, label]) => (
          <FilterChip key={k} active={selectedStates.has(k)} activeColor={STATE_COLORS[k]} onClick={() => toggleState(k)}>
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: STATE_COLORS[k] }} />
            {label}
            <span className="tabular" style={{ color: "var(--dim)" }}>
              {((viewStateMinutes[k] ?? 0) / 60).toFixed(1)}h
            </span>
          </FilterChip>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function Overview({
  data,
  current,
  cursorT,
  cursorIdx,
  setCursorIdx,
  hover,
  setHover,
}: {
  data: ClientPayload;
  current: Cockpit;
  cursorT: number;
  cursorIdx: number;
  setCursorIdx: Dispatch<SetStateAction<number>>;
  hover: number | null;
  setHover: (t: number | null) => void;
}) {
  const s = data.summary;
  // Only alarms get a rule on the depth chart. Marking all 49 events turned the
  // right-hand half of the plot into a picket fence and buried the depth trace,
  // which is the thing the chart exists to show.
  const markers = useMemo(
    () => data.anomalies.filter((a) => a.severity === "ALARM").map((a) => ({ t: a.from, color: SEV_COLOR[a.severity] })),
    [data.anomalies],
  );

  const lastIdx = data.cockpit.length - 1;
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);

  const {
    dayKeys,
    selectedDays,
    setSelectedDays,
    toggleDay,
    selectedStates,
    setSelectedStates,
    toggleState,
    viewWindow,
    maskSeries,
    viewSpans,
    viewStateMinutes,
    ribbonColors,
  } = useDayStateFilter(data);

  const viewDepth = useMemo(() => maskSeries(data.series.depth), [data.series.depth, maskSeries]);
  const viewBitDepth = useMemo(() => maskSeries(data.series.bitDepth), [data.series.bitDepth, maskSeries]);
  const chartMarkers = useMemo(
    () => (selectedDays.size === 0 ? markers : markers.filter((m) => selectedDays.has(dayStart(m.t)))),
    [markers, selectedDays],
  );

  // Clicking the chart or ribbon jumps the actual replay position there, not just a
  // hover preview.
  const seekTo = useCallback(
    (t: number) => {
      setPlaying(false);
      setHover(null);
      setCursorIdx(nearestCockpitIndex(data.cockpit, t));
    },
    [data.cockpit, setCursorIdx, setHover],
  );
  // While playing, a mouse that's merely resting over the chart from an earlier hover
  // would otherwise freeze the cursor line at that stale position instead of tracking
  // the scrubber - so ignore hover and always show the true replay position.
  const chartCursor = playing ? cursorT : (hover ?? cursorT);

  // The replay scrubber is scoped to whichever days are picked, so its range - and how
  // far a full scrub actually travels - matches what the chart above is showing.
  const windowRange = useMemo(() => {
    const arr = data.cockpit;
    if (selectedDays.size === 0) return { startIdx: 0, endIdx: lastIdx };
    let startIdx = arr.findIndex((c) => c[0] >= viewWindow.from);
    if (startIdx === -1) startIdx = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < arr.length && arr[i][0] <= viewWindow.to; i++) endIdx = i;
    return { startIdx, endIdx };
  }, [data.cockpit, selectedDays, viewWindow, lastIdx]);

  // Changing the day filter jumps the scrubber back to the start of the new range,
  // rather than leaving it pointing at a position that may no longer be in view.
  useEffect(() => {
    setPlaying(false);
    setCursorIdx(windowRange.startIdx);
  }, [windowRange.startIdx, windowRange.endIdx, setCursorIdx]);

  useEffect(() => {
    if (!playing) return;
    // Fixed number of ticks regardless of how many minutes are in the picked range, so
    // a full scrub plays out in roughly the same amount of time either way - speed
    // just scales that pace up or down.
    const span = windowRange.endIdx - windowRange.startIdx;
    const step = Math.max(1, Math.round((span / 400) * speed));
    const id = setInterval(() => {
      setCursorIdx((i) => {
        if (i >= windowRange.endIdx) {
          setPlaying(false);
          return windowRange.startIdx;
        }
        return Math.min(i + step, windowRange.endIdx);
      });
    }, 60);
    return () => clearInterval(id);
  }, [playing, speed, windowRange, setCursorIdx]);

  return (
    <>
      <div className="panel p-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold">Depth vs time</h2>
          <div className="flex items-center gap-3 text-[10px]" style={{ color: "var(--muted)" }}>
            <Legend color="var(--accent)" label="Hole depth" />
            <Legend color="#f0abfc" label="Bit depth" />
            <span style={{ color: "var(--dim)" }}>line breaks = feed gap</span>
          </div>
        </div>

        <DaysFilterRow dayKeys={dayKeys} selectedDays={selectedDays} setSelectedDays={setSelectedDays} toggleDay={toggleDay} />

        <TimeSeries
          // Bit depth is drawn first so hole depth sits on top. The two overlap exactly
          // while drilling - the bit IS at the bottom of the hole - so whichever draws
          // last is the one you see. Hole depth is the headline, and where the pink bit
          // trace emerges from under it is precisely the interesting part: a trip.
          series={[
            { points: viewBitDepth, color: "#f0abfc", label: "Bit depth" },
            { points: viewDepth, color: "var(--accent)", label: "Hole depth" },
          ]}
          height={220}
          invertY
          band={false}
          unit="ft"
          timeDomain={[viewWindow.from, viewWindow.to]}
          cursor={chartCursor}
          onHover={setHover}
          onSeek={seekTo}
          markers={chartMarkers}
        />

        <div className="mt-1">
          <StateRibbon
            spans={viewSpans}
            from={viewWindow.from}
            to={viewWindow.to}
            colors={ribbonColors}
            cursor={chartCursor}
            onHover={setHover}
            onSeek={seekTo}
          />
          <StatesFilterRow selectedStates={selectedStates} setSelectedStates={setSelectedStates} toggleState={toggleState} viewStateMinutes={viewStateMinutes} />
        </div>

        <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--dim)" }}>
              Replay
            </span>
            <button
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause replay" : "Play replay"}
              className="w-6 h-6 flex items-center justify-center rounded border text-[10px] leading-none"
              style={{ borderColor: "var(--line)", color: "var(--text)", background: "var(--panel-2)" }}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              aria-label="Playback speed"
              className="text-[11px] px-1.5 py-0.5 rounded border bg-transparent"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              {[0.1, 0.25, 0.5, 1, 2].map((v) => (
                <option key={v} value={v} style={{ background: "var(--panel)" }}>
                  {v}&times;
                </option>
              ))}
            </select>
            <span className="ml-auto text-[11px] tabular whitespace-nowrap" style={{ color: "var(--muted)" }}>
              {fmtStamp(current?.[0] ?? data.meta.to)}
            </span>
          </div>

          {/* Padded to PAD.left/PAD.right so the slider track lines up under the same
              time axis the depth chart and state ribbon above use. */}
          <div className="relative">
            <div style={{ paddingLeft: PAD.left, paddingRight: PAD.right }}>
              <input
                type="range"
                min={windowRange.startIdx}
                max={windowRange.endIdx}
                value={cursorIdx}
                onChange={(e) => {
                  setPlaying(false);
                  setCursorIdx(Number(e.target.value));
                }}
                className="w-full block"
                aria-label="Replay position"
              />
            </div>
            <div className="pointer-events-none absolute inset-0">
              {chartMarkers.map((m, i) => (
                <span
                  key={i}
                  className="absolute rounded-full"
                  style={{
                    width: 6,
                    height: 6,
                    top: "50%",
                    left: `calc(${PAD.left}px + ${(m.t - viewWindow.from) / Math.max(viewWindow.to - viewWindow.from, 1)} * (100% - ${PAD.left + PAD.right}px))`,
                    transform: "translate(-50%, -50%)",
                    background: m.color,
                  }}
                  title={fmtStamp(m.t)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={SHOW_ROP_WOB ? "grid lg:grid-cols-3 gap-4" : "grid lg:grid-cols-2 gap-4"}>
        {SHOW_ROP_WOB && (
          <div className="panel p-3 lg:col-span-2">
            <h2 className="text-[13px] font-semibold mb-1">ROP vs WOB</h2>
            <p className="text-[10px] mb-2" style={{ color: "var(--dim)" }}>
              One point per minute the well was actually being deepened. Colour is rotary speed. The dashed line is the
              offset well&apos;s historical WOB ceiling for this hole size - note how much of the cloud sits at or below zero
              weight, which is the sensor offset described under Data quality, not the bit floating.
            </p>
            <Scatter
              points={data.ropWob.map((p) => ({
                x: p.wob,
                y: p.rop,
                c: p.rpm,
                label: `${p.rop.toFixed(0)} ft/hr @ ${p.wob.toFixed(1)} klb, ${p.rpm} rpm, ${p.depth ?? "?"} ft`,
              }))}
              height={300}
              xLabel="Weight on bit (klb)"
              yLabel="ROP (ft/hr, measured)"
              envelopeX={data.offsetWob ?? undefined}
            />
          </div>
        )}

        {SHOW_ROP_WOB ? (
          <div className="space-y-4">
            <FiveDayPerformancePanel s={s} />
            <OffsetWellPanel data={data} />
          </div>
        ) : (
          <>
            <FiveDayPerformancePanel s={s} />
            <OffsetWellPanel data={data} />
          </>
        )}
      </div>

      <AgreementPanel data={data} />
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-3 h-0.5" style={{ background: color }} />
      {label}
    </span>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className="flex justify-between gap-3" title={hint}>
      <dt style={{ color: "var(--muted)" }}>
        {label}
        {hint && <span style={{ color: "var(--dim)" }}> &#9432;</span>}
      </dt>
      <dd className="tabular whitespace-nowrap" style={{ color: tone === "warn" ? "var(--watch)" : "var(--text)" }}>
        {value}
      </dd>
    </div>
  );
}

function FiveDayPerformancePanel({ s }: { s: ClientPayload["summary"] }) {
  return (
    <div className="panel p-3">
      <h2 className="text-[13px] font-semibold mb-2">Five-day performance</h2>
      <dl className="space-y-1.5 text-[12px]">
        <Stat label="Footage drilled" value={`${s.totalFootage.toLocaleString()} ft`} />
        <Stat label="Depth in / out" value={`${fmtNum(s.depthStart)} to ${fmtNum(s.depthEnd)} ft`} />
        <Stat label="Measured time" value={`${s.measuredHours.toFixed(1)} h`} />
        <Stat label="Feed missing" value={`${s.missingHours.toFixed(1)} h`} tone="warn" />
        <Stat label="On bottom" value={`${s.onBottomHours.toFixed(1)} h`} />
        <div className="pt-1.5 mt-1.5 border-t" style={{ borderColor: "var(--line)" }} />
        <Stat label="ROP on bottom" value={`${s.ropOnBottom?.toFixed(1)} ft/hr`} hint="footage / hours actually making hole - the bit performance number" />
        <Stat label="ROP overall" value={`${s.ropOverall?.toFixed(1)} ft/hr`} hint="footage / all measured hours - the delivery number" />
        <Stat
          label="Vendor ROP channel"
          value={`${s.ropChannelMean?.toFixed(2)} ft/hr`}
          tone="warn"
          hint="mean of the supplied ROP column. It never reads zero, so it mixes drilling rate with a floor value from hours when no hole was being made. Shown to expose the gap, not to be used."
        />
        <div className="pt-1.5 mt-1.5 border-t" style={{ borderColor: "var(--line)" }} />
        <Stat label="NPT reported (DDR)" value={`${s.ddrNptHours.toFixed(1)} h`} tone="warn" />
      </dl>
    </div>
  );
}

function OffsetWellPanel({ data }: { data: ClientPayload }) {
  return (
    <div className="panel p-3">
      <h2 className="text-[13px] font-semibold mb-1">Against the offset well</h2>
      <p className="text-[10px] mb-2" style={{ color: "var(--dim)" }}>
        Peak values this well reached while drilling, against the highest ever recorded on the offset well in the
        same hole size. The tick is the historical ceiling.
      </p>
      {data.envelope.map((e) => (
        <div key={e.section} className="mb-3 last:mb-0">
          <div className="text-[11px] mb-1" style={{ color: "var(--text)" }}>
            {e.section}
            <span className="ml-1 tabular" style={{ color: "var(--dim)" }}>
              ({(e.drilledMinutes / 60).toFixed(1)}h drilled)
            </span>
          </div>
          {e.comparison.rop && <EnvelopeBar label="ROP" actual={e.comparison.rop.actual} limit={e.comparison.rop.limit} unit="ft/hr" />}
          {e.comparison.spp && <EnvelopeBar label="Standpipe pressure" actual={e.comparison.spp.actual} limit={e.comparison.spp.limit} unit="psi" />}
          {e.comparison.flowRate && <EnvelopeBar label="Flow rate" actual={e.comparison.flowRate.actual} limit={e.comparison.flowRate.limit} unit="gpm" />}
          {e.comparison.torque && <EnvelopeBar label="Torque" actual={e.comparison.torque.actual} limit={e.comparison.torque.limit} unit="ft-lb" />}
        </div>
      ))}
    </div>
  );
}

type AgreementSortKey = "activity" | "ddrMinutes" | "agreement";

function SortHeader({
  label,
  align = "left",
  active,
  dir,
  onClick,
  className = "",
}: {
  label: string;
  align?: "left" | "right";
  active: boolean;
  dir: 1 | -1;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={`font-normal py-1 ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}
        style={{ color: active ? "var(--accent)" : "inherit" }}
      >
        {label}
        <span style={{ visibility: active ? "visible" : "hidden", fontSize: 9 }}>{dir === 1 ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

function AgreementPanel({ data }: { data: ClientPayload }) {
  const [sort, setSort] = useState<{ key: AgreementSortKey; dir: 1 | -1 }>({ key: "ddrMinutes", dir: -1 });
  const toggleSort = (key: AgreementSortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: key === "activity" ? 1 : -1 }));

  const rows = useMemo(() => {
    const out = [...data.agreement.rows];
    out.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return cmp * sort.dir;
    });
    return out;
  }, [data.agreement.rows, sort]);

  return (
    <div className="panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-[13px] font-semibold">State detection, checked against the driller&apos;s own report</h2>
        <span className="text-[12px] tabular" style={{ color: "var(--accent)" }}>
          {data.agreement.overall}% agreement over {data.agreement.scoredMinutes.toLocaleString()} minutes
        </span>
      </div>
      <p className="text-[10px] mb-3" style={{ color: "var(--dim)" }}>
        The daily drilling report is an independent, human-written account of the same five days, so it is the closest
        thing to ground truth available. This is a sanity check, not a target: a report line reading &ldquo;TIH, 8 hrs&rdquo; is a
        coarse envelope that also contains the circulating and connection breaks inside that trip, which the sensors
        resolve at minute scale and the paperwork rounds off. Disagreement is often the detector being more precise than
        the form it is being compared against.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr style={{ color: "var(--dim)" }}>
              <SortHeader label="Reported activity" active={sort.key === "activity"} dir={sort.dir} onClick={() => toggleSort("activity")} />
              <SortHeader label="Minutes" align="right" active={sort.key === "ddrMinutes"} dir={sort.dir} onClick={() => toggleSort("ddrMinutes")} />
              <SortHeader
                label="Agreement"
                align="right"
                className="pr-4"
                active={sort.key === "agreement"}
                dir={sort.dir}
                onClick={() => toggleSort("agreement")}
              />
              <th className="text-left font-normal">What the sensors said</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.activity} className="border-t" style={{ borderColor: "var(--line-soft)" }}>
                <td className="py-1.5 tabular">{r.activity}</td>
                <td className="text-right tabular" style={{ color: "var(--muted)" }}>
                  {r.ddrMinutes.toLocaleString()}
                </td>
                <td className="text-right tabular pr-4" style={{ color: r.agreement >= 65 ? "var(--drilling)" : r.agreement >= 40 ? "var(--watch)" : "var(--warn)" }}>
                  {r.agreement}%
                </td>
                <td className="py-1.5">
                  <div className="flex gap-2 flex-wrap">
                    {r.topDetected.map((d) => (
                      <span key={d.state} className="flex items-center gap-1" style={{ color: "var(--muted)" }}>
                        <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ background: STATE_COLORS[d.state] }} />
                        {STATE_LABEL[d.state] ?? d.state} <span className="tabular" style={{ color: "var(--dim)" }}>{d.minutes}</span>
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

function Telemetry({
  data,
  cursorT,
  setCursorIdx,
  hover,
  setHover,
}: {
  data: ClientPayload;
  cursorT: number;
  setCursorIdx: Dispatch<SetStateAction<number>>;
  hover: number | null;
  setHover: (t: number | null) => void;
}) {
  const {
    dayKeys,
    selectedDays,
    setSelectedDays,
    toggleDay,
    selectedStates,
    setSelectedStates,
    toggleState,
    viewWindow,
    maskSeries,
    viewSpans,
    viewStateMinutes,
    ribbonColors,
  } = useDayStateFilter(data);

  const seekTo = useCallback(
    (t: number) => {
      setHover(null);
      setCursorIdx(nearestCockpitIndex(data.cockpit, t));
    },
    [data.cockpit, setCursorIdx, setHover],
  );

  const charts: { key: keyof ClientPayload["series"]; title: string; unit: string; color: string; def: string; note?: string; band?: boolean }[] = [
    {
      key: "torque",
      title: "Rotary torque",
      unit: "ft-lb",
      color: "var(--reaming)",
      def: "The twisting force applied at surface to turn the drill string and bit - like the effort felt turning a stiff screwdriver.",
      note: "Line is the per-minute median of cleaned samples; the band is the full min-max spread within each minute. The band is the stick-slip signal - a mean-only chart would show a smooth line here and tell you nothing.",
    },
    {
      key: "torqueDispersion",
      title: "Torque dispersion index",
      unit: "nMAD",
      color: "var(--alarm)",
      band: false,
      def: "A derived measure of how erratic torque is within each minute, not a raw sensor reading - smooth-but-high torque is normal drilling, wildly swinging torque is stick-slip.",
      note: "Normalised median absolute deviation of torque within each minute - the robust measure the stick-slip detector fires on. Survives downsampling, unlike raw variance.",
    },
    {
      key: "hookload",
      title: "Hookload",
      unit: "klb",
      color: "var(--tripping-out)",
      def: "The total weight hanging on the traveling block - what the drilling line is holding up.",
      note: "The sawtooth is normal tripping: full string weight, then the slips. Spikes above the sawtooth peak are drag.",
    },
    {
      key: "spp",
      title: "Standpipe pressure",
      unit: "psi",
      color: "var(--circulating)",
      def: "The mud pressure at surface, measured just before drilling fluid is pumped down the drill pipe.",
    },
    {
      key: "flowIn",
      title: "Flow in",
      unit: "gpm",
      color: "var(--tripping-in)",
      def: "The rate drilling fluid is being pumped down the well.",
    },
    {
      key: "rpm",
      title: "Surface RPM",
      unit: "rpm",
      color: "var(--sliding)",
      def: "How fast the drill string is being rotated at surface.",
    },
    {
      key: "wob",
      title: "Weight on bit",
      unit: "klb",
      color: "var(--connection)",
      def: "How much of the string's weight is pushed down onto the rock at the bottom, rather than held by the hook - one of the two main levers (with RPM) used to control drilling speed.",
      note: "Reads negative through much of the drilling time. That is a sensor zero-offset fault, not the string floating - see Data quality.",
    },
    {
      key: "blockPos",
      title: "Block position",
      unit: "ft",
      color: "var(--muted)",
      def: "The vertical position of the traveling block in the derrick, which rises and falls as pipe is run in or out.",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="panel p-3">
        <DaysFilterRow dayKeys={dayKeys} selectedDays={selectedDays} setSelectedDays={setSelectedDays} toggleDay={toggleDay} />
        <StateRibbon spans={viewSpans} from={viewWindow.from} to={viewWindow.to} colors={ribbonColors} cursor={hover ?? cursorT} onHover={setHover} onSeek={seekTo} height={18} />
        <StatesFilterRow selectedStates={selectedStates} setSelectedStates={setSelectedStates} toggleState={toggleState} viewStateMinutes={viewStateMinutes} />
        <div className="text-[10px] px-[46px] mt-1" style={{ color: "var(--dim)" }}>
          Operational state, aligned to every chart below.
        </div>
      </div>

      {charts.map((c) => (
        <div key={c.key} className="panel p-3">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <h2 className="text-[13px] font-semibold">{c.title}</h2>
            <span className="text-[10px] tabular" style={{ color: "var(--dim)" }}>
              {c.unit}
            </span>
          </div>
          <p className="text-[10px] mb-1" style={{ color: "var(--muted)" }}>
            {c.def}
          </p>
          {c.note && (
            <p className="text-[10px] mb-1.5" style={{ color: "var(--dim)" }}>
              {c.note}
            </p>
          )}
          <TimeSeries
            series={[{ points: maskSeries(data.series[c.key] as Pt[]), color: c.color, label: c.title }]}
            height={140}
            band={c.band !== false}
            unit=""
            timeDomain={[viewWindow.from, viewWindow.to]}
            cursor={hover ?? cursorT}
            onHover={setHover}
            onSeek={seekTo}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Anomalies                                                           */
/* ------------------------------------------------------------------ */

function Anomalies({ data }: { data: ClientPayload }) {
  const [type, setType] = useState<string>("ALL");
  const types = useMemo(() => ["ALL", ...new Set(data.anomalies.map((a) => a.type))], [data.anomalies]);
  const rows = data.anomalies.filter((a) => type === "ALL" || a.type === type);

  return (
    <div className="space-y-3">
      <div className="panel p-3">
        <h2 className="text-[13px] font-semibold mb-1">Detected events</h2>
        <p className="text-[11px] mb-3" style={{ color: "var(--muted)" }}>
          Rule-based, not learned: five days of one well with no labelled events is nowhere near enough to train
          something that generalises, and on a rig a flag nobody can explain is a flag nobody acts on. Every event below
          shows the numbers it fired on, and says where the data limits the call.
        </p>
        <div className="flex gap-1.5 flex-wrap">
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className="px-2.5 py-1 rounded text-[11px] border transition-colors"
              style={{
                borderColor: type === t ? "var(--accent)" : "var(--line)",
                color: type === t ? "var(--accent)" : "var(--muted)",
                background: type === t ? "rgba(56,189,248,0.08)" : "transparent",
              }}
            >
              {t.replace(/_/g, " ").toLowerCase()}
              <span className="ml-1.5 tabular" style={{ color: "var(--dim)" }}>
                {t === "ALL" ? data.anomalies.length : data.anomalies.filter((a) => a.type === t).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 items-start">
        {rows.map((a) => (
          <div key={a.id} className="panel p-3" style={{ borderLeft: `3px solid ${SEV_COLOR[a.severity]}` }}>
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide" style={{ background: SEV_COLOR[a.severity], color: "#0a0e14" }}>
                {a.severity}
              </span>
              <span className="text-[12px] font-semibold">{a.type.replace(/_/g, " ").toLowerCase()}</span>
              <span
                className="ml-auto text-[10px] px-1.5 py-0.5 rounded border"
                style={{
                  borderColor: a.confidence === "HIGH" ? "var(--drilling)" : a.confidence === "MEDIUM" ? "var(--watch)" : "var(--warn)",
                  color: a.confidence === "HIGH" ? "var(--drilling)" : a.confidence === "MEDIUM" ? "var(--watch)" : "var(--warn)",
                }}
              >
                {a.confidence}
              </span>
            </div>

            <div className="text-[10px] tabular mb-1.5" style={{ color: "var(--muted)" }}>
              {fmtStamp(a.from)} &rarr; {fmtStamp(a.to)} ({a.durationMin} min)
            </div>

            <p className="text-[12px] mb-2">{a.headline}</p>

            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] mb-2">
              {Object.entries(a.evidence).map(([k, v]) => (
                <span key={k} style={{ color: "var(--dim)" }}>
                  {k.replace(/([A-Z])/g, " $1").toLowerCase()}:{" "}
                  <span className="tabular" style={{ color: "var(--muted)" }}>
                    {String(v)}
                  </span>
                </span>
              ))}
            </div>

            {a.caveat && (
              <p className="text-[10px] pl-2 border-l" style={{ color: "var(--dim)", borderColor: "var(--line)" }}>
                {a.caveat}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data quality                                                        */
/* ------------------------------------------------------------------ */

function Quality({ data }: { data: ClientPayload }) {
  const sevColor = { critical: "var(--alarm)", warn: "var(--warn)", info: "var(--muted)" } as const;

  // Most severe first. The pipeline emits these in the order the cleaning happens,
  // which is the right order for reading the code and the wrong order for reading
  // the page - it buried a CRITICAL finding below three WARNs.
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  const findings = [...data.quality].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return (
    <div className="space-y-3">
      <div className="panel p-3">
        <h2 className="text-[13px] font-semibold mb-1">What was wrong with the feed, and what was done about it</h2>
        <p className="text-[11px]" style={{ color: "var(--muted)" }}>
          {data.meta.rawRows.toLocaleString()} raw rows across {data.meta.minutes.toLocaleString()} minutes. Each finding
          below changed how a number on this dashboard is computed. This is served from{" "}
          <code className="tabular" style={{ color: "var(--accent)" }}>
            /api/quality
          </code>{" "}
          as well, so the caveats travel with the data rather than living in a README.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 items-start">
        {findings.map((q) => (
          <div key={q.id} className="panel p-3">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-semibold" style={{ background: sevColor[q.severity], color: "#0a0e14" }}>
                {q.severity}
              </span>
              <h3 className="text-[12px] font-semibold">{q.title}</h3>
            </div>
            {q.affectedRows > 0 && (
              <div className="text-[10px] tabular mb-1" style={{ color: "var(--dim)" }}>
                {q.affectedRows.toLocaleString()} rows &middot; {q.affectedPct}%
              </div>
            )}
            <p className="text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>
              {q.detail}
            </p>
            <p className="text-[11px] pl-2 border-l" style={{ borderColor: "var(--accent-dim)", color: "var(--text)" }}>
              <span style={{ color: "var(--accent)" }}>Action: </span>
              {q.action}
            </p>
          </div>
        ))}
      </div>

      <div className="panel p-3">
        <h2 className="text-[13px] font-semibold mb-2">Stated assumptions</h2>
        <ol className="space-y-1.5 text-[11px] list-decimal pl-4" style={{ color: "var(--muted)" }}>
          {data.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ol>
      </div>

      <div className="panel p-3">
        <h2 className="text-[13px] font-semibold mb-2">Feed gaps ({data.gaps.length})</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-[11px] tabular" style={{ color: "var(--muted)" }}>
          {[...data.gaps]
            .sort((a, b) => b.minutes - a.minutes)
            .slice(0, 15)
            .map((g, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span>{fmtStamp(g.from)}</span>
                <span style={{ color: g.minutes > 30 ? "var(--warn)" : "var(--dim)" }}>{g.minutes} min</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
