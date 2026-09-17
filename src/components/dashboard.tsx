"use client";

import { useState, useMemo, useDeferredValue } from "react";
import { TimeSeries, StateRibbon, Scatter, EnvelopeBar, fmtStamp, type Pt } from "./charts";
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

export default function Dashboard({ data }: { data: ClientPayload }) {
  const [tab, setTab] = useState<Tab>("overview");
  // The cursor is the "now" of the replay. Historical data played back against a
  // scrubber is the honest framing - this is a five-day export, not a live feed, and
  // pretending otherwise would be the first thing a drilling engineer caught.
  const [cursorIdx, setCursorIdx] = useState(data.cockpit.length - 1);
  const [hover, setHover] = useState<number | null>(null);

  const deferredIdx = useDeferredValue(cursorIdx);
  const current = data.cockpit[deferredIdx];
  const cursorT = current?.[0] ?? data.meta.to;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <Header data={data} current={current} />

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
        {tab === "telemetry" && <Telemetry data={data} cursorT={cursorT} hover={hover} setHover={setHover} />}
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
  // swinging, which is the stick-slip signature, so the alert is driven by the same
  // robust dispersion index the detector uses.
  const disp = current?.[11] ?? null;
  const torqueAlert = disp !== null && disp >= 1.1;

  return (
    <header className="border-b" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
      <div className="mx-auto max-w-[1400px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold tracking-tight">RigSight</span>
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
                replay
              </span>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
              {data.meta.well} &middot; rig {data.meta.rig} &middot; {data.meta.field} field
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
                  dispersion index {disp!.toFixed(2)} &middot; stick-slip signature
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
  setCursorIdx: (n: number) => void;
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

        <TimeSeries
          // Bit depth is drawn first so hole depth sits on top. The two overlap exactly
          // while drilling - the bit IS at the bottom of the hole - so whichever draws
          // last is the one you see. Hole depth is the headline, and where the pink bit
          // trace emerges from under it is precisely the interesting part: a trip.
          series={[
            { points: data.series.bitDepth, color: "#f0abfc", label: "Bit depth" },
            { points: data.series.depth, color: "var(--accent)", label: "Hole depth" },
          ]}
          height={220}
          invertY
          band={false}
          unit="ft"
          cursor={hover ?? cursorT}
          onHover={setHover}
          markers={markers}
        />

        <div className="mt-1">
          <StateRibbon
            spans={data.spans}
            from={data.meta.from}
            to={data.meta.to}
            colors={STATE_COLORS}
            cursor={hover ?? cursorT}
            onHover={setHover}
          />
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 px-[46px] text-[10px]">
            {Object.entries(STATE_LABEL)
              .filter(([k]) => data.stateMinutes[k])
              .sort((a, b) => (data.stateMinutes[b[0]] ?? 0) - (data.stateMinutes[a[0]] ?? 0))
              .map(([k, label]) => (
                <span key={k} className="flex items-center gap-1" style={{ color: "var(--muted)" }}>
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: STATE_COLORS[k] }} />
                  {label}
                  <span className="tabular" style={{ color: "var(--dim)" }}>
                    {((data.stateMinutes[k] ?? 0) / 60).toFixed(1)}h
                  </span>
                </span>
              ))}
          </div>
        </div>

        <div className="mt-3 pt-3 border-t flex items-center gap-3" style={{ borderColor: "var(--line)" }}>
          <span className="text-[10px] uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--dim)" }}>
            Replay
          </span>
          <input
            type="range"
            min={0}
            max={data.cockpit.length - 1}
            value={cursorIdx}
            onChange={(e) => setCursorIdx(Number(e.target.value))}
            className="flex-1"
            aria-label="Replay position"
          />
          <span className="text-[11px] tabular whitespace-nowrap" style={{ color: "var(--muted)" }}>
            {fmtStamp(current?.[0] ?? data.meta.to)}
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
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
            width={640}
            height={300}
            xLabel="Weight on bit (klb)"
            yLabel="ROP (ft/hr, measured)"
            envelopeX={data.offsetWob ?? undefined}
          />
        </div>

        <div className="space-y-4">
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
        </div>
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

function AgreementPanel({ data }: { data: ClientPayload }) {
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
              <th className="text-left font-normal py-1">Reported activity</th>
              <th className="text-right font-normal">Minutes</th>
              <th className="text-right font-normal pr-4">Agreement</th>
              <th className="text-left font-normal">What the sensors said</th>
            </tr>
          </thead>
          <tbody>
            {data.agreement.rows.map((r) => (
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
  hover,
  setHover,
}: {
  data: ClientPayload;
  cursorT: number;
  hover: number | null;
  setHover: (t: number | null) => void;
}) {
  const charts: { key: keyof ClientPayload["series"]; title: string; unit: string; color: string; note?: string; band?: boolean }[] = [
    {
      key: "torque",
      title: "Rotary torque",
      unit: "ft-lb",
      color: "var(--reaming)",
      note: "Line is the per-minute median of cleaned samples; the band is the full min-max spread within each minute. The band is the stick-slip signal - a mean-only chart would show a smooth line here and tell you nothing.",
    },
    {
      key: "torqueDispersion",
      title: "Torque dispersion index",
      unit: "nMAD",
      color: "var(--alarm)",
      band: false,
      note: "Normalised median absolute deviation of torque within each minute - the robust measure the stick-slip detector fires on. Survives downsampling, unlike raw variance.",
    },
    { key: "hookload", title: "Hookload", unit: "klb", color: "var(--tripping-out)", note: "The sawtooth is normal tripping: full string weight, then the slips. Spikes above the sawtooth peak are drag." },
    { key: "spp", title: "Standpipe pressure", unit: "psi", color: "var(--circulating)" },
    { key: "flowIn", title: "Flow in", unit: "gpm", color: "var(--tripping-in)" },
    { key: "rpm", title: "Surface RPM", unit: "rpm", color: "var(--sliding)" },
    { key: "wob", title: "Weight on bit", unit: "klb", color: "var(--connection)", note: "Reads negative through much of the drilling time. That is a sensor zero-offset fault, not the string floating - see Data quality." },
    { key: "blockPos", title: "Block position", unit: "ft", color: "var(--muted)" },
  ];

  return (
    <div className="space-y-3">
      <div className="panel p-3">
        <StateRibbon spans={data.spans} from={data.meta.from} to={data.meta.to} colors={STATE_COLORS} cursor={hover ?? cursorT} onHover={setHover} height={18} />
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
          {c.note && (
            <p className="text-[10px] mb-1.5" style={{ color: "var(--dim)" }}>
              {c.note}
            </p>
          )}
          <TimeSeries
            series={[{ points: data.series[c.key] as Pt[], color: c.color, label: c.title }]}
            height={140}
            band={c.band !== false}
            unit=""
            cursor={hover ?? cursorT}
            onHover={setHover}
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

      {rows.map((a) => (
        <div key={a.id} className="panel p-3" style={{ borderLeft: `3px solid ${SEV_COLOR[a.severity]}` }}>
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide" style={{ background: SEV_COLOR[a.severity], color: "#0a0e14" }}>
              {a.severity}
            </span>
            <span className="text-[12px] font-semibold">{a.type.replace(/_/g, " ").toLowerCase()}</span>
            <span className="text-[11px] tabular" style={{ color: "var(--muted)" }}>
              {fmtStamp(a.from)} &rarr; {fmtStamp(a.to)} ({a.durationMin} min)
            </span>
            <span
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded border"
              style={{
                borderColor: a.confidence === "HIGH" ? "var(--drilling)" : a.confidence === "MEDIUM" ? "var(--watch)" : "var(--warn)",
                color: a.confidence === "HIGH" ? "var(--drilling)" : a.confidence === "MEDIUM" ? "var(--watch)" : "var(--warn)",
              }}
            >
              {a.confidence} confidence
            </span>
          </div>

          <p className="text-[12px] mb-2">{a.headline}</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] mb-2">
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
  );
}

/* ------------------------------------------------------------------ */
/* Data quality                                                        */
/* ------------------------------------------------------------------ */

function Quality({ data }: { data: ClientPayload }) {
  const sevColor = { critical: "var(--alarm)", warn: "var(--warn)", info: "var(--muted)" } as const;

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

      {data.quality.map((q) => (
        <div key={q.id} className="panel p-3">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-semibold" style={{ background: sevColor[q.severity], color: "#0a0e14" }}>
              {q.severity}
            </span>
            <h3 className="text-[12px] font-semibold">{q.title}</h3>
            {q.affectedRows > 0 && (
              <span className="text-[10px] tabular ml-auto" style={{ color: "var(--dim)" }}>
                {q.affectedRows.toLocaleString()} rows &middot; {q.affectedPct}%
              </span>
            )}
          </div>
          <p className="text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>
            {q.detail}
          </p>
          <p className="text-[11px] pl-2 border-l" style={{ borderColor: "var(--accent-dim)", color: "var(--text)" }}>
            <span style={{ color: "var(--accent)" }}>Action: </span>
            {q.action}
          </p>
        </div>
      ))}

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
