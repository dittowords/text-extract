// Only for formats that process escapes. A doubled backslash resolves last, so
// `\\n` stays a backslash and an `n`.
export function decodeEscapes(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[nrt]|[^A-Za-z0-9])/g, (_, seq: string) => {
    switch (seq[0]) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u":
        return String.fromCharCode(parseInt(seq.slice(1), 16));
      default:
        return seq; // \\ ' " ` ? @ % …
    }
  });
}

// Line starts are cached for the last source, so a file with many hits is scanned once, not once per hit.
let cachedSource: string | null = null;
let cachedLineStarts: number[] = [];

// 1-based (line, column) from a byte offset into a UTF-16 source string.
// Treats LF as the line break; CR-only sources will report a single line.
export function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  if (source !== cachedSource) {
    cachedSource = source;
    cachedLineStarts = computeLineOffsets(source);
  }
  let lo = 0;
  let hi = cachedLineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cachedLineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - cachedLineStarts[lo] + 1 };
}

// Start offset of each line, indexed to match `source.split(/\r?\n/)`.
export function computeLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}
