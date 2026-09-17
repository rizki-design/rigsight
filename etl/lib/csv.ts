/**
 * Minimal RFC4180-ish CSV reader.
 *
 * Written by hand rather than pulled from npm for one reason: the DDR `COM` column
 * contains quoted, multi-line narrative with embedded "" escapes and stray CR
 * characters. Most lightweight parsers either choke on that or silently truncate
 * the narrative - which is the single richest field in the pack.
 */
export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM if the exporter left one (the DDR file has one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;                              // normalise CRLF
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }

  // Trailing record with no newline at EOF.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  // Drop fully blank trailing lines.
  while (rows.length && rows[rows.length - 1].every((f) => f.trim() === "")) rows.pop();
  return rows;
}

/**
 * Parse the feed's timestamp format: "M/D/YYYY H:MM" (24h, minute precision, no seconds).
 *
 * Deliberately built as a naive local-time instant via Date.UTC: the source has no
 * timezone marker, so we refuse to guess one. Every timestamp in this system is
 * "rig time" and is rendered as such. Using UTC internally keeps it stable across
 * whatever machine runs the pipeline - a real bug class when a dashboard is built
 * on a laptop in Jakarta and deployed to a box in us-east-1.
 */
export function parseFeedTimestamp(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, mo, d, y, h, mi] = m;
  return Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, 0, 0);
}

/**
 * Numeric coercion that reports *why* a value was rejected instead of silently
 * turning junk into 0. The telemetry contains 12 cells reading "5.0E" - a
 * scientific-notation literal truncated by whatever exported the file. Coercing
 * that to 0 would inject a fake zero-weight-on-bit reading mid-drilling.
 */
export function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
