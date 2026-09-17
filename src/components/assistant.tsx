"use client";

import { useState, useRef, useEffect } from "react";
import { fmtStamp } from "./charts";

interface Citation {
  row: number;
  score: number;
  well: string;
  rig: string;
  start: number;
  durationHrs: number;
  nptHrs: number;
  activity: string;
  phase: string;
  holeSize: string | null;
  depthFt: number | null;
  matchedTerms: string[];
  snippet: string;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  mode?: string;
  retrievalMs?: number;
  note?: string;
}

const SUGGESTIONS = [
  "What caused NPT on SEBL_002?",
  "Summarise torque and drag problems on the night shift",
  "What went wrong with the mud pumps?",
  "Why did they pull out of the hole on 12 September?",
  "Any losses or well control events?",
];

/**
 * Chat surface over the daily drilling reports.
 *
 * It answers from retrieval by default - every sentence assembled from fields that
 * were actually returned - so it runs with no API key and cannot invent an event
 * that is not in the reports. If ANTHROPIC_API_KEY is configured, the same retrieved
 * rows are passed to Claude for a more fluent summary and the toggle below becomes
 * meaningful. The citations are identical either way, because they come from
 * retrieval rather than from the model.
 */
export function DdrAssistant({ meta }: { meta: { well: string; rig: string } }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [synthesise, setSynthesise] = useState(false);
  const [wellFilter, setWellFilter] = useState<string>("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setTurns((t) => [...t, { role: "user", text: q }]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/ddr/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: q,
          limit: 8,
          synthesise,
          filters: wellFilter ? { well: wellFilter } : {},
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? `request failed (${res.status})`);

      setTurns((t) => [
        ...t,
        { role: "assistant", text: json.answer, citations: json.citations, mode: json.mode, retrievalMs: json.retrievalMs, note: json.modelNote },
      ]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", text: `Could not answer that: ${err instanceof Error ? err.message : "unknown error"}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-4 items-start">
      <div className="panel flex flex-col" style={{ height: "min(72vh, 760px)" }}>
        <div className="p-3 border-b flex flex-wrap items-center gap-3" style={{ borderColor: "var(--line)" }}>
          <div>
            <h2 className="text-[13px] font-semibold">DDR assistant</h2>
            <p className="text-[10px]" style={{ color: "var(--dim)" }}>
              568 report lines across SEBL_001 and SEBL_002. Answers cite the exact rows they came from.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <select
              value={wellFilter}
              onChange={(e) => setWellFilter(e.target.value)}
              className="text-[11px] px-2 py-1 rounded border bg-transparent"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              <option value="" style={{ background: "var(--panel)" }}>
                Both wells
              </option>
              <option value="SEBL_001" style={{ background: "var(--panel)" }}>
                SEBL_001
              </option>
              <option value="SEBL_002" style={{ background: "var(--panel)" }}>
                SEBL_002
              </option>
            </select>
            <label className="flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: "var(--muted)" }} title="Passes the same retrieved rows to Claude for a more fluent summary. Requires ANTHROPIC_API_KEY; falls back to the grounded answer if unset.">
              <input type="checkbox" checked={synthesise} onChange={(e) => setSynthesise(e.target.checked)} />
              LLM summary
            </label>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!turns.length && (
            <div className="text-[11px] space-y-3" style={{ color: "var(--muted)" }}>
              <p>
                Ask about anything in the daily drilling reports. Retrieval is BM25 over the free-text narrative plus the
                coded columns, with a drilling synonym list so &ldquo;stuck pipe&rdquo; also finds drag, overpull and tight hole.
              </p>
              <div className="flex flex-col gap-1.5 items-start">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="text-left px-2.5 py-1.5 rounded border text-[11px] transition-colors hover:border-[var(--accent)]"
                    style={{ borderColor: "var(--line)", color: "var(--text)" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] px-3 py-2 rounded-lg text-[12px]" style={{ background: "var(--accent-dim)", color: "#e6f6ff" }}>
                  {t.text}
                </div>
              </div>
            ) : (
              <div key={i} className="space-y-2">
                <div className="px-3 py-2 rounded-lg text-[12px] whitespace-pre-wrap" style={{ background: "var(--panel-2)" }}>
                  {t.text}
                </div>
                <div className="flex flex-wrap gap-2 text-[10px]" style={{ color: "var(--dim)" }}>
                  {t.mode && (
                    <span className="px-1.5 py-0.5 rounded border" style={{ borderColor: "var(--line)" }}>
                      {t.mode === "grounded" ? "grounded - built from retrieved fields only" : "synthesised by Claude from retrieved rows"}
                    </span>
                  )}
                  {t.retrievalMs !== undefined && <span className="tabular">retrieval {t.retrievalMs} ms</span>}
                </div>
                {t.note && (
                  <p className="text-[10px] pl-2 border-l" style={{ color: "var(--watch)", borderColor: "var(--watch)" }}>
                    {t.note}
                  </p>
                )}
                {t.citations && t.citations.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer" style={{ color: "var(--accent)" }}>
                      {t.citations.length} cited report lines
                    </summary>
                    <div className="mt-2 space-y-2">
                      {t.citations.map((c) => (
                        <div key={c.row} className="p-2 rounded border" style={{ borderColor: "var(--line)", background: "var(--panel-2)" }}>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1 text-[10px]">
                            <span className="tabular px-1 rounded" style={{ background: "var(--line)", color: "var(--muted)" }}>
                              row {c.row}
                            </span>
                            <span className="tabular" style={{ color: "var(--muted)" }}>
                              {fmtStamp(c.start)}
                            </span>
                            <span style={{ color: "var(--text)" }}>{c.well}</span>
                            <span style={{ color: "var(--accent)" }}>{c.activity}</span>
                            <span className="tabular" style={{ color: "var(--dim)" }}>
                              {c.durationHrs}h
                            </span>
                            {c.nptHrs > 0 && (
                              <span className="tabular px-1 rounded" style={{ background: "var(--warn)", color: "#0a0e14" }}>
                                {c.nptHrs}h NPT
                              </span>
                            )}
                            {c.depthFt ? (
                              <span className="tabular" style={{ color: "var(--dim)" }}>
                                {c.depthFt} ft
                              </span>
                            ) : null}
                          </div>
                          <p style={{ color: "var(--muted)" }}>{c.snippet}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ),
          )}

          {busy && (
            <div className="text-[11px] flex items-center gap-2" style={{ color: "var(--muted)" }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--accent)" }} />
              searching the reports...
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
          className="p-3 border-t flex gap-2"
          style={{ borderColor: "var(--line)" }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about ${meta.well} or SEBL_001...`}
            className="flex-1 px-3 py-2 rounded text-[12px] bg-transparent border outline-none focus:border-[var(--accent)]"
            style={{ borderColor: "var(--line)", color: "var(--text)" }}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="px-3.5 py-2 rounded text-[12px] font-medium disabled:opacity-40"
            style={{ background: "var(--accent)", color: "#0a0e14" }}
          >
            Ask
          </button>
        </form>
      </div>

      <div className="panel p-3 space-y-3 text-[11px]">
        <h3 className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>
          How this works
        </h3>
        <p style={{ color: "var(--muted)" }}>
          BM25 lexical retrieval over the <code style={{ color: "var(--accent)" }}>COM</code> narrative, with the coded
          columns indexed alongside it so <code style={{ color: "var(--accent)" }}>EQRPR</code> or a hole size matches
          even when the prose never spells it out.
        </p>
        <p style={{ color: "var(--muted)" }}>
          Not a vector store, deliberately. 568 rows do not need an approximate index, and these questions are dominated
          by exact rare tokens - depths, activity codes, tool names - which is exactly where dense retrieval
          underperforms BM25. The one thing lexical search genuinely loses is vocabulary mismatch, which is handled with
          an explicit drilling synonym list a drilling engineer can read and correct.
        </p>
        <p style={{ color: "var(--muted)" }}>
          At field scale this becomes hybrid retrieval - BM25 for rare exact tokens, embeddings for paraphrase, fused by
          reciprocal rank.
        </p>
        <div className="pt-2 border-t" style={{ borderColor: "var(--line)" }}>
          <p style={{ color: "var(--dim)" }}>
            Also available as <code style={{ color: "var(--accent)" }}>POST /api/ddr/query</code> with filters for well,
            rig, activity, phase, hole size, NPT, time range and depth range.
          </p>
        </div>
      </div>
    </div>
  );
}
