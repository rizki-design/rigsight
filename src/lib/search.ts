import type { DdrRow } from "./types";

/**
 * ---------------------------------------------------------------------------
 * RETRIEVAL OVER THE DAILY DRILLING REPORTS
 * ---------------------------------------------------------------------------
 * Lexical BM25 over the free-text `COM` narrative, with the coded columns used as
 * hard filters and every answer carrying row-level citations.
 *
 * Why BM25 and not embeddings, which is what "RAG" usually implies:
 *
 *  - The corpus is 568 rows. A vector index earns its keep at scale, by making
 *    similarity search sublinear. At this size it is a dependency, a model download
 *    and an index build to accelerate a scan that already runs in under a
 *    millisecond.
 *  - The questions in this domain are dominated by exact tokens - depths, code
 *    strings like EQRPR and DRLDD, tool names, bit sizes. Dense retrieval is worse
 *    at exact rare tokens than BM25 is; that is the well-known failure mode it needs
 *    a hybrid to patch. Here the lexical half is the useful half.
 *  - Citations must be exact. An engineer acting on "what caused the NPT" needs the
 *    specific report line, not a paraphrase of a nearby chunk.
 *  - It runs with no API key and no network, so the demo cannot fail on stage and a
 *    reviewer needs no credentials to clone and run it.
 *
 * The one thing pure lexical search genuinely loses is vocabulary mismatch - asking
 * about "stuck pipe" when the report says "drag" and "overpull". That is handled
 * with an explicit domain synonym list below, which has the side benefit of being
 * readable and correctable by a drilling engineer, which an embedding is not.
 *
 * Where this would change: at tens of thousands of reports across a field, or for
 * genuinely semantic questions, this becomes hybrid retrieval - BM25 for the rare
 * exact tokens, embeddings for the paraphrases, fused by reciprocal rank.
 */

/**
 * BM25 term-frequency saturation.
 *
 * k1 = 1.5 is the textbook default and it is wrong for this corpus. Drilling reports
 * are repetitive equipment lists, so a word repeating a dozen times usually means
 * "this line is a packing manifest", not "this line is strongly about that word".
 *
 * Measured example: a rig-move report says "pipe" 13 times in 257 tokens and
 * outranked a drilling report reading "Got tight spot @ 4761" - where "tight" occurs
 * once, but appears in only 2 of 568 documents. At k1 = 1.5 the common word repeated
 * thirteen times wins; at k1 = 0.8 the tf curve flattens fast enough that the rare,
 * specific word wins, which is the correct answer.
 *
 * b is raised slightly above the 0.75 default for the same reason: the long documents
 * here are long because they are lists, not because they are informative.
 */
const K1 = 0.8;
const B = 0.85;

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were", "are", "have",
  "has", "had", "not", "but", "all", "any", "can", "will", "his", "her", "its",
  "out", "off", "per", "via", "due", "you", "our", "their", "what", "when", "which",
  "how", "why", "did", "does", "into", "onto", "over", "under", "after", "before",
  "during", "while", "then", "than", "there", "here", "been", "being", "also",
  // Short function words. The tokenizer keeps two-character tokens because real
  // drilling vocabulary needs them (MP, MW, TF, DC), so these must be listed.
  "of", "on", "to", "in", "at", "is", "it", "as", "by", "or", "we", "do", "up",
  "no", "if", "so", "an", "be", "he", "my", "me", "us", "am", "are", "our",
  // Question scaffolding that would otherwise be treated as content.
  "summarize", "summarise", "tell", "show", "find", "give", "about", "shift",
  "happened", "caused", "cause", "any", "some", "more", "most", "went", "wrong",
  "get", "got", "put", "made", "make", "they", "them",
]);

/**
 * Domain vocabulary. Each line maps a phrase an engineer might type to the words the
 * reports actually use. Kept as plain data so it can be extended by someone who
 * knows drilling but not code.
 */
const SYNONYMS: Record<string, string[]> = {
  // "pack" was here for pack-off. It was removed after it matched "Power Pack" - a
  // generator on a rig-move truck manifest - and pushed a loading list to the top of
  // a stuck-pipe query. A short synonym is only worth having if it is unambiguous in
  // the corpus it is searching.
  stuck: ["drag", "overpull", "tight", "stuck", "backream", "packoff", "bridge"],
  "stuck pipe": ["drag", "overpull", "tight", "stuck", "backream", "packoff"],
  npt: ["eqrpr", "opsus", "repair", "suspended", "waiting", "breakdown", "trouble"],
  downtime: ["eqrpr", "opsus", "repair", "suspended", "waiting"],
  torque: ["torque", "tq", "stall", "rotate", "rotary"],
  "stick slip": ["torque", "stall", "vibration", "oscillat"],
  washout: ["washout", "leak", "pressure", "spp", "drop"],
  pump: ["pump", "mp", "liner", "stroke", "spm", "seat", "valve"],
  mud: ["mud", "mw", "ppg", "ecd", "viscosity", "lcm", "sweep"],
  losses: ["loss", "losses", "lcm", "seepage", "lost"],
  kick: ["kick", "influx", "gain", "shut", "flow", "check"],
  bit: ["bit", "pdc", "tfa", "nozzle", "dull"],
  bha: ["bha", "motor", "agitator", "stabilizer", "mwd", "steerable"],
  casing: ["casing", "csg", "shoe", "cement", "cmt", "liner"],
  trip: ["tih", "toh", "pooh", "trip", "run"],
  survey: ["survey", "inc", "azi", "mwd", "directional"],
  cement: ["cement", "cmt", "woc", "slurry", "toc"],
  weather: ["rain", "weather", "lightning", "storm", "swa"],
  safety: ["swa", "pjsm", "hse", "drill", "jsa", "toolbox"],
  night: ["midnight", "night"],
  bop: ["bop", "boptst", "accumulator", "choke", "annular", "ram"],
};

export interface IndexedDoc {
  row: DdrRow;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

export interface SearchIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
  n: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9./'-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((t) => t.length >= 2 && t.length <= 24 && !STOP.has(t));
}

let indexCache: SearchIndex | null = null;

export function buildIndex(rows: DdrRow[]): SearchIndex {
  if (indexCache && indexCache.n === rows.length) return indexCache;

  const docs: IndexedDoc[] = rows.map((row) => {
    // The coded columns are indexed alongside the narrative, so "EQRPR" or "8.5"
    // matches even when the free text never spells it out.
    const text = [
      row.comment,
      row.activity,
      row.phase1,
      row.phase2,
      row.wellPhase,
      row.holeSize ?? "",
      row.well,
      row.rig,
    ].join(" \n ");

    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { row, tokens, tf, len: tokens.length };
  });

  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);

  indexCache = {
    docs,
    df,
    avgLen: docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1),
    n: docs.length,
  };
  return indexCache;
}

export interface SearchFilters {
  well?: string;
  rig?: string;
  activity?: string;
  phase?: string;
  holeSize?: string;
  nptOnly?: boolean;
  from?: number;
  to?: number;
  depthMin?: number;
  depthMax?: number;
}

export interface SearchHit {
  score: number;
  row: DdrRow;
  /** The matched terms, so the caller can show why this row came back. */
  matched: string[];
  /** A short window of the narrative around the best match, for display. */
  snippet: string;
}

function expandQuery(q: string): string[] {
  const lower = q.toLowerCase();
  const terms = new Set(tokenize(q));

  // Multi-word domain phrases first, so "stuck pipe" expands as a phrase.
  for (const [phrase, syns] of Object.entries(SYNONYMS)) {
    if (phrase.includes(" ") && lower.includes(phrase)) for (const s of syns) terms.add(s);
  }
  for (const t of [...terms]) {
    const syns = SYNONYMS[t];
    if (syns) for (const s of syns) terms.add(s);
  }
  return [...terms];
}

/**
 * Shift-aware filtering. "Night shift" is a real, frequently-asked slice, and on this
 * rig the reports themselves mark it - several narratives carry an explicit
 * "After Midnight" separator. Nights are taken as 18:00-06:00 rig time.
 */
export function detectShift(q: string): "night" | "day" | null {
  const l = q.toLowerCase();
  if (/\bnight\b|\bnights\b|after midnight|overnight/.test(l)) return "night";
  if (/\bday shift\b|\bdaytime\b|\bdays\b/.test(l)) return "day";
  return null;
}

function inShift(t: number, shift: "night" | "day"): boolean {
  const h = new Date(t).getUTCHours(); // timestamps are naive rig time stored as UTC
  return shift === "night" ? h >= 18 || h < 6 : h >= 6 && h < 18;
}

/**
 * If the question names a well or rig outright, treat that as a filter rather than
 * just another search term.
 *
 * Asking "what caused NPT on SEBL_002" and getting SEBL_001 lines back is technically
 * correct ranking and obviously wrong to a human. An explicit identifier in the
 * question is an instruction, not a hint. An explicit filter passed by the caller
 * still wins over one inferred here.
 */
function inferFilters(query: string, filters: SearchFilters): SearchFilters {
  const out = { ...filters };
  if (!out.well) {
    const m = query.match(/\bSEBL[_\s-]?0*(\d+)\b/i);
    if (m) {
      const norm = "SEBL_" + m[1].padStart(3, "0");
      if (norm === "SEBL_001" || norm === "SEBL_002") out.well = norm;
    }
  }
  if (!out.rig) {
    const m = query.match(/\bPHR[_\s-]?0*(\d+)\b/i);
    if (m) out.rig = m[1] === "5" ? "PHR-05" : `PHR-0${m[1]}`;
  }
  return out;
}

export function search(
  index: SearchIndex,
  query: string,
  rawFilters: SearchFilters = {},
  limit = 8,
): SearchHit[] {
  const filters = inferFilters(query, rawFilters);
  const allTerms = expandQuery(query);
  const shift = detectShift(query);
  if (!allTerms.length) return [];

  /**
   * Drop query terms that appear in more than a third of the corpus.
   *
   * Drilling narratives are extremely repetitive: "pipe", "mud", "hole" and "rig"
   * turn up in most reports and carry almost no discriminative power, but a long
   * document repeating one of them still accumulates a high BM25 score. Asking about
   * "stuck pipe or tight hole while tripping" returned a rig-move note about loading
   * pipe racks ahead of a report that actually reads "Got tight spot @ 4761" -
   * because it said "pipe" more times.
   *
   * Filtering on document frequency rather than a hand-written stoplist means this
   * adapts to whatever corpus it is pointed at, instead of needing someone to
   * remember that "pipe" is noise on a drilling rig. If every term is common, the
   * filter would leave nothing, so it falls back to the full set.
   */
  const discriminating = allTerms.filter((t) => (index.df.get(t) ?? 0) / index.n <= 0.35);
  const terms = discriminating.length ? discriminating : allTerms;

  const candidates = index.docs.filter(({ row }) => {
    if (filters.well && row.well !== filters.well) return false;
    if (filters.rig && row.rig !== filters.rig) return false;
    if (filters.activity && row.activity !== filters.activity) return false;
    if (filters.phase && row.phase1 !== filters.phase && row.phase2 !== filters.phase) return false;
    if (filters.holeSize && row.holeSize !== filters.holeSize) return false;
    if (filters.nptOnly && row.nptHrs <= 0) return false;
    if (filters.from !== undefined && row.end < filters.from) return false;
    if (filters.to !== undefined && row.start > filters.to) return false;
    if (filters.depthMin !== undefined && (row.depthFt ?? 0) < filters.depthMin) return false;
    if (filters.depthMax !== undefined && (row.depthFt ?? 0) > filters.depthMax) return false;
    if (shift && !inShift(row.start, shift)) return false;
    return true;
  });

  const hits: SearchHit[] = [];

  for (const doc of candidates) {
    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      const f = doc.tf.get(term);
      if (!f) continue;
      const df = index.df.get(term) ?? 0;
      // BM25 IDF with the +0.5 smoothing, floored at zero so a term appearing in
      // almost every document cannot push a score negative.
      const idf = Math.max(0, Math.log(1 + (index.n - df + 0.5) / (df + 0.5)));
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * doc.len) / index.avgLen));
      matched.push(term);
    }

    if (score <= 0) continue;

    /**
     * Coordination factor: reward covering more of the question rather than hitting
     * one common word many times.
     *
     * Plain BM25 gets this wrong on drilling narratives, because the vocabulary is
     * so repetitive. Asking about "stuck pipe or tight hole while tripping"
     * originally returned a rig-move report at the top - a note about loading pipe
     * racks that happened to say "pipe" a dozen times - ahead of a drilling report
     * that literally reads "Got tight spot @ 4761". Term frequency on one generic
     * token beat genuine relevance.
     *
     * Scaling by the square root of the fraction of query concepts a document
     * matches fixes that: the square root keeps it a nudge rather than an override,
     * so a document that strongly matches most of the question still wins over one
     * that weakly matches all of it.
     */
    score *= Math.sqrt(new Set(matched).size / terms.length);

    /**
     * Intent-aware nudge: when the question is about something going wrong, prefer
     * report lines that actually booked non-productive time.
     *
     * This matters because the vocabulary works against us. Asking "what went wrong
     * with the mud pumps" pulls up routine drilling-parameter blocks, which mention
     * mud and pump pressures every single shift, ahead of the one line reading
     * "Repair MP #1 adjust chain sprocket" - which is short, writes "MP" rather than
     * "pump", and is the actual answer. The NPT column is independent evidence that
     * a line describes a problem, so it is used as a prior rather than relying on
     * the prose alone.
     */
    const problemIntent = /npt|problem|issue|delay|lost|fail|wrong|broke|repair|damage|trouble|stuck|downtime|suspend/i;
    if (filters.nptOnly || problemIntent.test(query)) {
      if (doc.row.nptHrs > 0) score *= 1.6;
    }

    hits.push({ score: +score.toFixed(3), row: doc.row, matched, snippet: snippet(doc.row.comment, matched) });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Pull the ~240-character window of narrative that contains the densest match. */
function snippet(text: string, terms: string[], width = 240): string {
  const clean = text.replace(/\s*\n\s*/g, " / ").replace(/\s{2,}/g, " ").trim();
  if (clean.length <= width) return clean;
  if (!terms.length) return clean.slice(0, width) + "...";

  const lower = clean.toLowerCase();
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < clean.length - 40; i += 20) {
    const w = lower.slice(i, i + width);
    let s = 0;
    for (const t of terms) if (w.includes(t)) s++;
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  const prefix = best > 0 ? "..." : "";
  const suffix = best + width < clean.length ? "..." : "";
  return prefix + clean.slice(best, best + width).trim() + suffix;
}

/**
 * Deterministic answer composed from the retrieved rows.
 *
 * The assistant answers from this by default, with no model in the loop. Every
 * sentence is built from a field that was actually retrieved, so it cannot state
 * anything the reports do not contain - and it works with no API key. When
 * ANTHROPIC_API_KEY is set, the same retrieved rows are passed to Claude for a more
 * fluent summary; the citations are identical either way, because they come from
 * retrieval rather than from the model.
 */
export function composeAnswer(hits: SearchHit[]): string {
  if (!hits.length) {
    return "Nothing in the daily drilling reports matches that. Try naming an activity code (EQRPR, TOH, DRLDD), a well (SEBL_001, SEBL_002), a hole size, or a depth range.";
  }

  const nptHits = hits.filter((h) => h.row.nptHrs > 0);
  const totalNpt = nptHits.reduce((a, h) => a + h.row.nptHrs, 0);
  const wells = [...new Set(hits.map((h) => h.row.well))];
  const activities = [...new Set(hits.map((h) => h.row.activity))];
  const span = {
    from: Math.min(...hits.map((h) => h.row.start)),
    to: Math.max(...hits.map((h) => h.row.end)),
  };
  const d = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

  const lines: string[] = [];
  lines.push(
    `${hits.length} report line${hits.length === 1 ? "" : "s"} match, on ${wells.join(" and ")} between ${d(span.from)} and ${d(span.to)} (rig time). Activity codes involved: ${activities.join(", ")}.`,
  );

  if (nptHits.length) {
    lines.push(
      `${nptHits.length} of them carry non-productive time, ${totalNpt.toFixed(2)} hours in total. The largest is ${nptHits[0].row.nptHrs} hr on ${d(nptHits[0].row.start)} under ${nptHits[0].row.activity}.`,
    );
  }

  lines.push("");
  lines.push("Top matches:");
  for (const h of hits.slice(0, 5)) {
    const npt = h.row.nptHrs > 0 ? `, ${h.row.nptHrs} hr NPT` : "";
    const depth = h.row.depthFt ? `, ${h.row.depthFt} ft` : "";
    lines.push(
      `- [${h.row.idx}] ${d(h.row.start)} - ${h.row.well} / ${h.row.rig} - ${h.row.activity} (${h.row.durationHrs} hr${npt}${depth})\n  ${h.snippet}`,
    );
  }

  return lines.join("\n");
}
