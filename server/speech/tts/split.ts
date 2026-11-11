/** Split text into provider-sized pieces without ever dropping content. */

const SENTENCES = (t: string) => t.match(/[^.!?。！？\n]*[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？\n]+\s*|\n+/g) ?? [t];
const CLAUSES = (t: string) => t.match(/[^,;:，；：、]*[,;:，；：、]+\s*|[^,;:，；：、]+$/g) ?? [t];
const WORDS = (t: string) => t.match(/\S+\s*/g) ?? [t];
const LEVELS = [SENTENCES, CLAUSES, WORDS];

function hardCut(text: string, max: number): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(text.length, pos + max);
    // Never split a surrogate pair.
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    if (end <= pos) end = pos + 1;
    const piece = text.slice(pos, end).trim();
    if (piece) out.push(piece);
    pos = end;
  }
  return out;
}

function splitLevel(text: string, max: number, level: number): string[] {
  if (text.trim().length <= max) return text.trim() ? [text.trim()] : [];
  if (level >= LEVELS.length) return hardCut(text, max);
  const units = LEVELS[level](text);
  if (units.length <= 1) return splitLevel(text, max, level + 1);
  const out: string[] = [];
  let current = "";
  const flush = () => { if (current.trim()) out.push(current.trim()); current = ""; };
  for (const unit of units) {
    if (unit.length > max && unit.trim().length > max) {
      flush();
      out.push(...splitLevel(unit, max, level + 1));
    } else if ((current + unit).trimEnd().length > max) {
      flush();
      current = unit;
    } else {
      current += unit;
    }
  }
  flush();
  return out;
}

/**
 * Split on sentence, then clause, then word boundaries, finally by hard cut, packing neighbours
 * up to `maxChars`. Joining the result reproduces the input (modulo boundary whitespace).
 * `maxChars <= 0` means the provider has no limit.
 */
export function splitTextForTts(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!(maxChars > 0) || trimmed.length <= maxChars) return [trimmed];
  return splitLevel(trimmed, Math.floor(maxChars), 0);
}
