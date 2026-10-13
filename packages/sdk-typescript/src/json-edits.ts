/**
 * Edits to recorded JSON text that keep every byte they do not change. Placing a file in a value
 * read from JSON text (an attribute, or a tool call's JSON-encoded arguments) replaces only the
 * file's own value, or the members of the part that held it; the rest of the text, its key order,
 * number spellings and whitespace included, is kept as it was recorded. Mirrors the Python SDK's
 * `_json_edits.py`, so both SDKs write the same bytes.
 */

/** One change at a JSON pointer of a document: its value replaced by `value` (JSON text), or,
 * for an object, the member `remove` dropped and each `set` member's value replaced in place or
 * appended. */
export type JsonEdit =
  | { pointer: string; value: string }
  | { pointer: string; remove?: string; set?: readonly [string, string][] };

interface Member {
  key: string;
  start: number;
  valueStart: number;
  end: number;
}

interface Located {
  start: number;
  end: number;
  /** For an object: its members in order, the text after `{` and before `}`. */
  members?: Member[];
}

const segment = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** The spans of the values at `wanted` pointers of valid JSON `text`, with the members of each
 * object among them. A duplicate key's last member is the one a pointer names. */
function locate(text: string, wanted: ReadonlySet<string>): Map<string, Located> {
  const prefixes = new Set<string>();
  for (const pointer of wanted)
    for (let at = pointer.length; at >= 0; at = pointer.lastIndexOf("/", at - 1)) {
      prefixes.add(pointer.slice(0, at));
      if (at === 0) break;
    }
  const found = new Map<string, Located>();
  const space = (index: number) => {
    let at = index;
    for (;;) {
      const code = text.charCodeAt(at);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) at++;
      else return at;
    }
  };
  const stringEnd = (index: number) => {
    // A string without escapes ends at the next quote, found natively: a long file's content
    // is passed over without a step per character.
    const quote = text.indexOf('"', index + 1);
    if (quote !== -1 && !text.slice(index + 1, quote).includes("\\")) return quote + 1;
    let at = index + 1;
    for (;;) {
      const code = text.charCodeAt(at);
      if (code === 0x22) return at + 1;
      at += code === 0x5c ? 2 : 1;
    }
  };
  /** The end of the value starting at `index`, and an object's members when asked. */
  const valueEnd = (index: number, members?: Member[]): number => {
    const code = text.charCodeAt(index);
    if (code === 0x22) return stringEnd(index);
    if (code === 0x7b || code === 0x5b) {
      const object = code === 0x7b;
      let at = space(index + 1);
      if (text.charCodeAt(at) === (object ? 0x7d : 0x5d)) return at + 1;
      for (;;) {
        let key = "";
        let start = at;
        if (object) {
          const keyEnd = stringEnd(at);
          if (members) key = JSON.parse(text.slice(at, keyEnd)) as string;
          at = space(space(keyEnd) + 1);
        }
        const valueStart = at;
        const end = valueEnd(at);
        if (members) members.push({ key, start, valueStart, end });
        at = space(end);
        if (text.charCodeAt(at) === 0x2c) {
          at = space(at + 1);
          start = at;
          continue;
        }
        return at + 1;
      }
    }
    let at = index;
    for (;;) {
      const code = text.charCodeAt(at);
      // A number's characters, or a literal's letters.
      if (
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2d ||
        code === 0x2b ||
        code === 0x2e ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x45
      )
        at++;
      else return at;
    }
  };
  const visit = (index: number, pointer: string): void => {
    const code = text.charCodeAt(index);
    const descend = code === 0x7b || code === 0x5b;
    const members: Member[] | undefined = descend ? [] : undefined;
    const end = valueEnd(index, members);
    if (wanted.has(pointer))
      found.set(pointer, code === 0x7b ? { start: index, end, members } : { start: index, end });
    if (!members) return;
    const last = new Map<string, Member>();
    members.forEach((member, position) =>
      last.set(code === 0x7b ? member.key : String(position), member),
    );
    for (const [key, member] of last) {
      const child = `${pointer}/${segment(key)}`;
      if (prefixes.has(child)) visit(member.valueStart, child);
    }
  };
  visit(space(0), "");
  return found;
}

interface Piece {
  start: number;
  end: number;
  render: () => string;
}

/**
 * `text` with `edits` applied, every byte outside the changed values kept. Each object edit
 * keeps the object's other members, the separators between them and its whitespace; appended
 * members are written compactly (`,"key":value`) before the closing brace.
 */
export function applyJsonEdits(text: string, edits: readonly JsonEdit[]): string {
  if (!edits.length) return text;
  const values = new Map<string, string>();
  const objects = new Map<string, { remove: Set<string>; set: Map<string, string> }>();
  for (const edit of edits) {
    if ("value" in edit) values.set(edit.pointer, edit.value);
    else {
      const object = objects.get(edit.pointer) ?? { remove: new Set(), set: new Map() };
      if (edit.remove !== undefined) object.remove.add(edit.remove);
      for (const [key, value] of edit.set ?? []) object.set.set(key, value);
      objects.set(edit.pointer, object);
    }
  }
  const located = locate(text, new Set([...values.keys(), ...objects.keys()]));
  const pieces: Piece[] = [];
  for (const [pointer, value] of values) {
    const span = located.get(pointer);
    if (span) pieces.push({ start: span.start, end: span.end, render: () => value });
  }
  for (const [pointer, edit] of objects) {
    const span = located.get(pointer);
    if (!span?.members) continue;
    const members = span.members;
    // The last member of each key set in place keeps its position; the others are appended.
    const lastOf = new Map<string, Member>();
    for (const member of members) lastOf.set(member.key, member);
    for (const [key, value] of edit.set) {
      const member = lastOf.get(key);
      if (member && !edit.remove.has(key))
        pieces.push({ start: member.valueStart, end: member.end, render: () => value });
    }
    pieces.push({
      start: span.start,
      end: span.end,
      render: () => {
        const first = members[0]?.start ?? span.end - 1;
        const close = members.length ? members.at(-1)!.end : span.end - 1;
        let out = text.slice(span.start, first);
        let kept = 0;
        members.forEach((member, index) => {
          if (edit.remove.has(member.key)) return;
          // The separator that preceded this member, comma included, unless it now comes first.
          if (kept++ > 0) out += text.slice(members[index - 1]!.end, member.start);
          out += render(member.start, member.end);
        });
        let appended = "";
        for (const [key, value] of edit.set)
          if (!lastOf.has(key) || edit.remove.has(key))
            appended += `${kept || appended ? "," : ""}${JSON.stringify(key)}:${value}`;
        return out + appended + text.slice(close, span.end);
      },
    });
  }
  pieces.sort((a, b) => a.start - b.start || b.end - a.end);
  /** The text from `start` to `end` with the pieces within it rendered; a piece inside another
   * is rendered by the outer one. Only the pieces that start within the range are visited. */
  const render = (start: number, end: number): string => {
    let out = "";
    let at = start;
    // The first piece starting at or after `start`, found by halving.
    let low = 0;
    let high = pieces.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pieces[middle]!.start < start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < pieces.length; index++) {
      const piece = pieces[index]!;
      if (piece.start >= end) break;
      if (piece.start < at || piece.end > end) continue;
      out += text.slice(at, piece.start) + piece.render();
      at = piece.end;
    }
    return out + text.slice(at, end);
  };
  return render(0, text.length);
}
