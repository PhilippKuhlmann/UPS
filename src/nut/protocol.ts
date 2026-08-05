/**
 * Wire-level helpers for the NUT (Network UPS Tools) TCP protocol, as spoken by
 * `upsd` on port 3493. The protocol is line based; arguments that may contain
 * spaces arrive as double-quoted strings with backslash escaping.
 *
 * Reference exchanges:
 *   > LIST UPS
 *   < BEGIN LIST UPS
 *   < UPS eaton "Eaton 5PX 1500"
 *   < END LIST UPS
 *
 *   > LIST VAR eaton
 *   < BEGIN LIST VAR eaton
 *   < VAR eaton battery.charge "100"
 *   < END LIST VAR eaton
 */

export class NutError extends Error {
  readonly code: string;

  constructor(code: string, command?: string) {
    super(command ? `NUT server returned ${code} for "${command}"` : `NUT server returned ${code}`);
    this.name = 'NutError';
    this.code = code;
  }
}

/**
 * Splits a protocol line into tokens. Bare tokens are whitespace separated;
 * quoted tokens keep their inner spaces and honour `\"` and `\\` escapes.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < line.length) {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= line.length) break;

    if (line[i] === '"') {
      i++;
      let value = '';
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          value += line[i + 1];
          i += 2;
        } else {
          value += line[i];
          i++;
        }
      }
      i++; // closing quote
      tokens.push(value);
    } else {
      let value = '';
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t') {
        value += line[i];
        i++;
      }
      tokens.push(value);
    }
  }

  return tokens;
}

/** Quotes a value for use as a command argument. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Decides whether a command's reply is a single line or a `BEGIN LIST … END LIST`
 * block, so the reader knows when to stop collecting.
 */
export function isListCommand(command: string): boolean {
  return /^LIST\s/i.test(command);
}

export interface ListReply {
  /** The type word after BEGIN LIST, e.g. `UPS`, `VAR`, `CMD`, `RW`. */
  type: string;
  /** Each entry, already tokenized, with the leading record keyword removed. */
  rows: string[][];
}

/** Parses the lines of a `BEGIN LIST … END LIST` block into typed rows. */
export function parseListReply(lines: string[], command: string): ListReply {
  const first = lines[0] ?? '';
  const beginTokens = tokenize(first);

  if (beginTokens[0] === 'ERR') {
    throw new NutError(beginTokens[1] ?? 'UNKNOWN', command);
  }
  if (beginTokens[0] !== 'BEGIN' || beginTokens[1] !== 'LIST') {
    throw new Error(`Unexpected reply to "${command}": ${first}`);
  }

  const type = beginTokens[2] ?? '';
  const rows: string[][] = [];

  for (const line of lines.slice(1, -1)) {
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    rows.push(tokens.slice(1));
  }

  return { type, rows };
}

/** Parses a single-line reply, throwing on `ERR`. */
export function parseSingleReply(line: string, command: string): string[] {
  const tokens = tokenize(line);
  if (tokens[0] === 'ERR') {
    throw new NutError(tokens[1] ?? 'UNKNOWN', command);
  }
  return tokens;
}
