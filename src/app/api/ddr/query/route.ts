import { db, badRequest } from "@/lib/data";
import { buildIndex, search, composeAnswer, type SearchFilters } from "@/lib/search";

/**
 * POST /api/ddr/query
 *
 * Retrieval over the daily drilling reports, returning an answer plus the exact
 * report lines it was built from.
 *
 * Body:
 *   { "query": "what caused NPT on SEBL_002",
 *     "filters": { "well": "SEBL_002", "nptOnly": true, "activity": "EQRPR",
 *                  "holeSize": "8.5", "from": <ms>, "to": <ms>,
 *                  "depthMin": 3000, "depthMax": 4000 },
 *     "limit": 8,
 *     "synthesise": true }
 *
 * Two answer modes, and the distinction is deliberate:
 *
 *   grounded  (default) - the answer is assembled from retrieved fields only. It
 *              cannot assert anything the reports do not contain, needs no API key
 *              and no network, and is what the demo runs on.
 *
 *   synthesised - the same retrieved rows are handed to Claude for a more fluent
 *              summary, used only when ANTHROPIC_API_KEY is set and the caller asks
 *              for it. The citations are identical either way, because they come
 *              from retrieval, not from the model. If the call fails for any reason
 *              the response falls back to the grounded answer rather than erroring -
 *              a walkthrough should never die because a third party is having a bad
 *              afternoon.
 *
 * The model never sees the corpus, only the top-k rows, and is instructed to answer
 * strictly from them. That is the part that keeps an LLM honest on operational data:
 * constrain what it can see, and cite what it was given.
 */

export async function POST(req: Request) {
  let body: { query?: string; filters?: SearchFilters; limit?: number; synthesise?: boolean };
  try {
    body = await req.json();
  } catch {
    return badRequest("body must be JSON");
  }

  const query = (body.query ?? "").trim();
  if (!query) return badRequest("query is required");
  if (query.length > 500) return badRequest("query must be 500 characters or fewer");

  const limit = Math.min(Math.max(Number(body.limit ?? 8), 1), 25);
  const { ddr } = db();
  const index = buildIndex(ddr);

  const t0 = Date.now();
  const hits = search(index, query, body.filters ?? {}, limit);
  const retrievalMs = Date.now() - t0;

  const grounded = composeAnswer(hits);
  let answer = grounded;
  let mode: "grounded" | "synthesised" = "grounded";
  let modelNote: string | undefined;

  if (body.synthesise && hits.length) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      modelNote = "ANTHROPIC_API_KEY is not set, so the grounded answer was returned. Retrieval and citations are unaffected.";
    } else {
      try {
        const synthesised = await synthesise(query, hits, key);
        if (synthesised) {
          answer = synthesised;
          mode = "synthesised";
        }
      } catch (err) {
        modelNote = `Model synthesis failed (${err instanceof Error ? err.message : "unknown error"}); returned the grounded answer instead.`;
      }
    }
  }

  return Response.json({
    query,
    mode,
    answer,
    modelNote,
    retrievalMs,
    citations: hits.map((h) => ({
      // `row` is the index into the source CSV, so a citation is checkable against
      // the original file rather than against something this system made up.
      row: h.row.idx,
      score: h.score,
      well: h.row.well,
      rig: h.row.rig,
      start: h.row.start,
      durationHrs: h.row.durationHrs,
      nptHrs: h.row.nptHrs,
      activity: h.row.activity,
      phase: [h.row.phase1, h.row.phase2].filter(Boolean).join(" / "),
      holeSize: h.row.holeSize,
      depthFt: h.row.depthFt,
      matchedTerms: h.matched,
      snippet: h.snippet,
    })),
    retrieval: {
      method: "BM25 over the free-text COM narrative plus the coded columns, with a drilling synonym list for vocabulary mismatch (for example 'stuck pipe' also matches drag, overpull and tight hole).",
      corpusRows: index.n,
      why: "Lexical rather than vector retrieval: 568 rows do not need an approximate index, and the questions are dominated by exact rare tokens - depths, codes like EQRPR, tool names - which is precisely where dense retrieval underperforms BM25. At field scale this becomes hybrid retrieval with reciprocal-rank fusion.",
    },
  });
}

/** Ask Claude to summarise the retrieved lines - and nothing else. */
async function synthesise(query: string, hits: ReturnType<typeof search>, apiKey: string): Promise<string | null> {
  const context = hits
    .map((h) => {
      const d = new Date(h.row.start).toISOString().slice(0, 16).replace("T", " ");
      return [
        `[row ${h.row.idx}] ${d} rig time | ${h.row.well} / ${h.row.rig}`,
        `activity=${h.row.activity} phase=${h.row.phase1}/${h.row.phase2} duration=${h.row.durationHrs}h npt=${h.row.nptHrs}h depth=${h.row.depthFt ?? "n/a"}ft holeSize=${h.row.holeSize ?? "n/a"}`,
        h.row.comment.replace(/\s*\n\s*/g, " / ").slice(0, 1200),
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system:
        "You answer questions about drilling operations for a drilling engineer, using ONLY the daily drilling report lines provided. " +
        "Cite the row numbers you used, in the form [row 123]. " +
        "If the provided lines do not answer the question, say so plainly and state what they do cover - never fill a gap with general drilling knowledge. " +
        "Report durations and depths exactly as given. Be concise and factual; no preamble.",
      messages: [{ role: "user", content: `Question: ${query}\n\nDaily drilling report lines:\n\n${context}` }],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = json.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  return text || null;
}
