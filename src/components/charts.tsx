"use client";

import { useMemo, useState, useRef, useCallback, useEffect } from "react";

/**
 * ---------------------------------------------------------------------------
 * CHART PRIMITIVES
 * ---------------------------------------------------------------------------
 * Hand-built SVG rather than a charting library, for three reasons that are all
 * specific to this dataset:
 *
 *  1. The band matters more than the line. Every series here carries a min/max
 *     envelope and a standard deviation, because the short-timescale spread IS the
 *     stick-slip signal. A default line chart plots the mean and throws the rest
 *     away - the exact failure the brief warns about.
 *
 *  2. Gaps must break, not bridge. 46 feed gaps exist, one of them 144 minutes.
 *     Most libraries happily draw a straight line across missing time, which reads
 *     as "the rig was doing something smooth here" when the truth is "nobody was
 *     measuring".
 *
 *  3. Control of downsampling. What reaches the browser is already aggregated by the
 *     pipeline, so the chart renders what it is given rather than silently
 *     re-sampling it a second time.
 */

export interface Pt {
  t: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  sd: number | null;
  n: number;
}

export const PAD = { top: 10, right: 12, bottom: 20, left: 46 };

/** Tracks an element's rendered CSS width so a chart can fill its real container
 * instead of the viewBox's fallback pixel size (which only matches by coincidence). */
function useMeasuredWidth<T extends Element>(fallback: number) {
  const ref = useRef<T>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setMeasured(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, measured ?? fallback] as const;
}

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo];
  const span = hi - lo;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

const fmtVal = (v: number) =>
  v === 0
    ? "0"
    : Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString()
      : Math.abs(v) >= 10
        ? v.toFixed(0)
        : v.toFixed(2);

export const fmtClock = (t: number) => new Date(t).toISOString().slice(11, 16);
export const fmtDay = (t: number) => new Date(t).toISOString().slice(5, 10).replace("-", "/");
export const fmtStamp = (t: number) => `${fmtDay(t)} ${fmtClock(t)}`;

/**
 * Time-series chart with an optional min/max band.
 *
 * `invertY` draws depth increasing downward, which is how every driller expects to
 * read a depth-versus-time plot.
 */
export function TimeSeries({
  series,
  width: propWidth = 900,
  height = 180,
  color = "#38bdf8",
  band = true,
  invertY = false,
  unit = "",
  domain,
  timeDomain,
  cursor,
  onHover,
  onSeek,
  markers = [],
}: {
  series: { points: Pt[]; color?: string; label: string }[];
  width?: number;
  height?: number;
  color?: string;
  band?: boolean;
  invertY?: boolean;
  unit?: string;
  domain?: [number, number];
  /** Overrides the x-axis range instead of deriving it from the points' own min/max -
   * use this whenever the chart must line up with another component (e.g. the state
   * ribbon) sharing the same nominal window, since a feed gap at the edge of that
   * window can leave the actual first/last point short of it. */
  timeDomain?: [number, number];
  cursor?: number | null;
  onHover?: (t: number | null) => void;
  /** Click-to-seek: fires with the timestamp under the click. */
  onSeek?: (t: number) => void;
  markers?: { t: number; color: string; label?: string }[];
}) {
  const [ref, width] = useMeasuredWidth<SVGSVGElement>(propWidth);

  const { xs, ys, tMin, tMax, yMin, yMax } = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const withVal = all.filter((p) => p.mean !== null);
    const tMin = timeDomain ? timeDomain[0] : Math.min(...all.map((p) => p.t));
    const tMax = timeDomain ? timeDomain[1] : Math.max(...all.map((p) => p.t));

    let lo = domain ? domain[0] : Math.min(...withVal.map((p) => (band ? (p.min ?? p.mean!) : p.mean!)));
    let hi = domain ? domain[1] : Math.max(...withVal.map((p) => (band ? (p.max ?? p.mean!) : p.mean!)));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const padY = (hi - lo) * 0.08 || 1;
    lo -= padY;
    hi += padY;

    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const xs = (t: number) => PAD.left + ((t - tMin) / Math.max(tMax - tMin, 1)) * w;
    const ys = (v: number) => {
      const frac = (v - lo) / Math.max(hi - lo, 1e-9);
      return invertY ? PAD.top + frac * h : PAD.top + (1 - frac) * h;
    };
    return { xs, ys, tMin, tMax, yMin: lo, yMax: hi };
  }, [series, width, height, band, invertY, domain, timeDomain]);

  /**
   * Build the path in segments, starting a new one at every null point. This is what
   * makes a feed gap render as a break in the line rather than as a straight bridge
   * across time nobody measured.
   */
  const buildPath = (pts: Pt[]) => {
    const segs: string[] = [];
    let cur = "";
    for (const p of pts) {
      if (p.mean === null) {
        if (cur) segs.push(cur);
        cur = "";
        continue;
      }
      cur += `${cur ? "L" : "M"}${xs(p.t).toFixed(1)},${ys(p.mean).toFixed(1)}`;
    }
    if (cur) segs.push(cur);
    return segs.join(" ");
  };

  const buildBand = (pts: Pt[]) => {
    const segs: string[] = [];
    let top: string[] = [];
    let bot: string[] = [];
    const flush = () => {
      if (top.length > 1) segs.push(`M${top.join("L")}L${bot.reverse().join("L")}Z`);
      top = [];
      bot = [];
    };
    for (const p of pts) {
      if (p.mean === null || p.min === null || p.max === null) {
        flush();
        continue;
      }
      top.push(`${xs(p.t).toFixed(1)},${ys(p.max).toFixed(1)}`);
      bot.push(`${xs(p.t).toFixed(1)},${ys(p.min).toFixed(1)}`);
    }
    flush();
    return segs.join(" ");
  };

  const timeAt = useCallback(
    (e: React.MouseEvent<SVGSVGElement>): number | null => {
      if (!ref.current) return null;
      const rect = ref.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * width;
      const frac = (x - PAD.left) / (width - PAD.left - PAD.right);
      if (frac < 0 || frac > 1) return null;
      return tMin + frac * (tMax - tMin);
    },
    [tMin, tMax, width],
  );
  const handleMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => onHover?.(timeAt(e)), [onHover, timeAt]);
  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const t = timeAt(e);
      if (t !== null) onSeek?.(t);
    },
    [onSeek, timeAt],
  );

  const ticks = niceTicks(yMin, yMax, 4);
  const dayTicks = useMemo(() => {
    const out: number[] = [];
    const DAY = 86_400_000;
    for (let t = Math.ceil(tMin / (DAY / 4)) * (DAY / 4); t <= tMax; t += DAY / 4) out.push(t);
    return out;
  }, [tMin, tMax]);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height, cursor: onSeek ? "pointer" : undefined }}
      onMouseMove={handleMove}
      onMouseLeave={() => onHover?.(null)}
      onClick={handleClick}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={width - PAD.right} y1={ys(v)} y2={ys(v)} stroke="var(--line-soft)" strokeWidth={1} />
          <text x={PAD.left - 6} y={ys(v) + 3} textAnchor="end" fontSize={9} fill="var(--dim)" className="tabular">
            {fmtVal(v)}
          </text>
        </g>
      ))}

      {dayTicks.map((t) => (
        <g key={t}>
          <line x1={xs(t)} x2={xs(t)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--line-soft)" strokeWidth={1} />
          <text x={xs(t)} y={height - 6} textAnchor="middle" fontSize={9} fill="var(--dim)" className="tabular">
            {new Date(t).getUTCHours() === 0 ? fmtDay(t) : fmtClock(t)}
          </text>
        </g>
      ))}

      {markers.map((m, i) => (
        <line key={i} x1={xs(m.t)} x2={xs(m.t)} y1={PAD.top} y2={height - PAD.bottom} stroke={m.color} strokeWidth={1} opacity={0.45} />
      ))}

      {series.map((s, i) => (
        <g key={i}>
          {band && <path d={buildBand(s.points)} fill={s.color ?? color} opacity={0.16} />}
          <path d={buildPath(s.points)} fill="none" stroke={s.color ?? color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
        </g>
      ))}

      {cursor != null && cursor >= tMin && cursor <= tMax && (
        <line x1={xs(cursor)} x2={xs(cursor)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" />
      )}

      {unit && (
        <text x={PAD.left - 6} y={PAD.top - 1} textAnchor="end" fontSize={8} fill="var(--dim)">
          {unit}
        </text>
      )}
    </svg>
  );
}

/** Operational-state ribbon: one coloured block per span, aligned to the charts above. */
export function StateRibbon({
  spans,
  from,
  to,
  width: propWidth = 900,
  height = 22,
  cursor,
  onHover,
  onSeek,
  colors,
}: {
  spans: { state: string; from: number; to: number }[];
  from: number;
  to: number;
  width?: number;
  height?: number;
  cursor?: number | null;
  onHover?: (t: number | null) => void;
  /** Click-to-seek: fires with the timestamp under the click. */
  onSeek?: (t: number) => void;
  colors: Record<string, string>;
}) {
  const [ref, width] = useMeasuredWidth<SVGSVGElement>(propWidth);
  const w = width - PAD.left - PAD.right;
  const xs = (t: number) => PAD.left + ((t - from) / Math.max(to - from, 1)) * w;
  const timeAt = (e: React.MouseEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const frac = (x - PAD.left) / w;
    return frac < 0 || frac > 1 ? null : from + frac * (to - from);
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height, cursor: onSeek ? "pointer" : undefined }}
      onMouseMove={(e) => onHover?.(timeAt(e))}
      onMouseLeave={() => onHover?.(null)}
      onClick={(e) => {
        const t = timeAt(e);
        if (t !== null) onSeek?.(t);
      }}
    >
      <rect x={PAD.left} y={2} width={w} height={height - 4} fill="var(--nodata)" rx={3} />
      {spans.map((s, i) => {
        const x1 = xs(s.from);
        const x2 = xs(s.to);
        if (x2 < PAD.left || x1 > width - PAD.right) return null;
        return (
          <rect
            key={i}
            x={Math.max(x1, PAD.left)}
            y={2}
            width={Math.max(0.6, Math.min(x2, width - PAD.right) - Math.max(x1, PAD.left))}
            height={height - 4}
            fill={colors[s.state] ?? "var(--static)"}
          />
        );
      })}
      {cursor != null && (
        <line x1={xs(cursor)} x2={xs(cursor)} y1={0} y2={height} stroke="#fff" strokeWidth={1.5} />
      )}
    </svg>
  );
}

/** ROP against WOB, one dot per drilling minute, coloured by rotary speed. */
export function Scatter({
  points,
  width: propWidth = 440,
  height = 280,
  xLabel,
  yLabel,
  envelopeX,
  envelopeY,
}: {
  points: { x: number; y: number; c: number; label?: string }[];
  width?: number;
  height?: number;
  xLabel: string;
  yLabel: string;
  envelopeX?: number;
  envelopeY?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useMeasuredWidth<SVGSVGElement>(propWidth);
  const P = { top: 12, right: 14, bottom: 34, left: 48 };

  const { xs, ys, xTicks, yTicks } = useMemo(() => {
    const xVals = points.map((p) => p.x);
    const yVals = points.map((p) => p.y);
    // Clip the axes at the 99th percentile so a couple of extreme spikes do not
    // squash the cloud everyone actually needs to read.
    const sx = [...xVals].sort((a, b) => a - b);
    const sy = [...yVals].sort((a, b) => a - b);
    const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] ?? 0;
    const xLo = Math.min(0, q(sx, 0.01));
    const xHi = Math.max(q(sx, 0.99), envelopeX ?? 0) * 1.08;
    const yLo = 0;
    const yHi = Math.max(q(sy, 0.99), envelopeY ?? 0) * 1.08;

    const w = width - P.left - P.right;
    const h = height - P.top - P.bottom;
    return {
      xs: (v: number) => P.left + ((v - xLo) / Math.max(xHi - xLo, 1e-9)) * w,
      ys: (v: number) => P.top + (1 - (v - yLo) / Math.max(yHi - yLo, 1e-9)) * h,
      xTicks: niceTicks(xLo, xHi, 4),
      yTicks: niceTicks(yLo, yHi, 4),
    };
  }, [points, width, height, envelopeX, envelopeY, P.left, P.right, P.top, P.bottom]);

  // Cool-to-warm ramp for rotary speed: perceptually ordered, and distinct from the
  // state and severity palettes so nothing reads as an alert by accident.
  const ramp = (c: number) => {
    const t = Math.max(0, Math.min(1, c / 120));
    const stops: [number, string][] = [
      [0, "#3b82f6"],
      [0.5, "#22d3ee"],
      [0.75, "#a3e635"],
      [1, "#fbbf24"],
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) return stops[i - 1][1];
    }
    return stops[stops.length - 1][1];
  };

  return (
    <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={P.left} x2={width - P.right} y1={ys(v)} y2={ys(v)} stroke="var(--line-soft)" />
          <text x={P.left - 6} y={ys(v) + 3} textAnchor="end" fontSize={9} fill="var(--dim)" className="tabular">
            {fmtVal(v)}
          </text>
        </g>
      ))}
      {xTicks.map((v) => (
        <g key={`x${v}`}>
          <line x1={xs(v)} x2={xs(v)} y1={P.top} y2={height - P.bottom} stroke="var(--line-soft)" />
          <text x={xs(v)} y={height - P.bottom + 12} textAnchor="middle" fontSize={9} fill="var(--dim)" className="tabular">
            {fmtVal(v)}
          </text>
        </g>
      ))}

      {envelopeX !== undefined && envelopeX > 0 && (
        <g>
          <line x1={xs(envelopeX)} x2={xs(envelopeX)} y1={P.top} y2={height - P.bottom} stroke="var(--alarm)" strokeDasharray="4 3" strokeWidth={1} opacity={0.8} />
          <text x={xs(envelopeX) - 4} y={P.top + 9} textAnchor="end" fontSize={8} fill="var(--alarm)">
            offset max
          </text>
        </g>
      )}
      {envelopeY !== undefined && envelopeY > 0 && (
        <line x1={P.left} x2={width - P.right} y1={ys(envelopeY)} y2={ys(envelopeY)} stroke="var(--alarm)" strokeDasharray="4 3" strokeWidth={1} opacity={0.8} />
      )}

      {points.map((p, i) => (
        <circle
          key={i}
          cx={xs(p.x)}
          cy={ys(p.y)}
          r={hover === i ? 3.6 : 1.7}
          fill={ramp(p.c)}
          opacity={hover === null || hover === i ? 0.75 : 0.28}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
        />
      ))}

      {hover !== null && points[hover]?.label && (
        <text
          x={Math.min(xs(points[hover].x) + 8, width - 120)}
          y={Math.max(ys(points[hover].y) - 8, 14)}
          fontSize={9}
          fill="var(--text)"
          className="tabular"
        >
          {points[hover].label}
        </text>
      )}

      <text x={width / 2} y={height - 2} textAnchor="middle" fontSize={9} fill="var(--muted)">
        {xLabel}
      </text>
      <text x={10} y={height / 2} textAnchor="middle" fontSize={9} fill="var(--muted)" transform={`rotate(-90 10 ${height / 2})`}>
        {yLabel}
      </text>
    </svg>
  );
}

/** Horizontal comparison bar: today's value against the offset-well ceiling. */
export function EnvelopeBar({ label, actual, limit, unit }: { label: string; actual: number; limit: number; unit: string }) {
  const max = Math.max(actual, limit) * 1.1;
  const aPct = (actual / max) * 100;
  const lPct = (limit / max) * 100;
  const over = actual > limit;

  return (
    <div className="py-1.5">
      <div className="flex justify-between text-[11px] mb-1">
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span className="tabular" style={{ color: over ? "var(--alarm)" : "var(--text)" }}>
          {fmtVal(actual)} / {fmtVal(limit)} {unit}
        </span>
      </div>
      <div className="relative h-2 rounded-sm" style={{ background: "var(--panel-2)" }}>
        <div
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width: `${aPct}%`, background: over ? "var(--alarm)" : "var(--accent)" }}
        />
        <div className="absolute inset-y-[-3px] w-px" style={{ left: `${lPct}%`, background: "var(--text)", opacity: 0.85 }} />
      </div>
    </div>
  );
}
