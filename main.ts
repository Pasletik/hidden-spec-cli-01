// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON text-editor
// tool calls, finds the lines an edit names at three matching tiers even when
// the model drifted their whitespace or indentation, and changes every file
// or none. Node 22, standard library alone: `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A patch's lines (SPEC section 3): split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (SPEC section 3). */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines with its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFileText(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br: '\n', final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serializeFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  state(p: string): string | null {
    return this.get(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------- section 5: matching lines at three tiers ----------

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which old occurs at or after `from`. */
function findMatch(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, old, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: ctx >= 0 marks a context line standing for old[ctx]; ctx -1 is an added line. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines written in place of the matched old lines (SPEC section 5). */
function buildReplacement(
  fileLines: string[],
  pos: number,
  old: string[],
  neu: NewLine[],
  tier: number,
): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(old[0] ?? '');
  return neu.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    let t = n.text;
    if (tier === 2 && stripBoth(t) !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

// ---------- section 4: detecting the format ----------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------- section 6: unified diffs ----------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  rawEmpty: boolean;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined; // undefined: no pair; null: /dev/null
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function parseGitLine(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep <= 2) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

function parseHeaderPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  const p = trimSpaces(raw);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  const startSection = (s: Section): void => {
    finishHunk();
    sections.push(s);
    cur = s;
  };
  const fresh = (): Section => ({
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  });

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (hunk !== null) {
      const endsBody =
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) ||
        !(line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'));
      if (!endsBody) {
        if (line === '') hunk.body.push({ kind: ' ', text: '', rawEmpty: true });
        else hunk.body.push({ kind: line[0] as BodyLine['kind'], text: line.slice(1), rawEmpty: false });
        i += 1;
        continue;
      }
      finishHunk();
      // fall through: the line is handled outside the body
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseGitLine(line, lineNo);
      const s = fresh();
      s.gitOld = x;
      s.gitNew = y;
      startSection(s);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${lineNo}`);
      hunk = { a: Number(m[1]), body: [] };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseHeaderPath(line);
      const newP = parseHeaderPath(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
      } else if (cur !== null && cur.hunks.length === 0) {
        // a second pair inside the same header: not a new section, ignored
      } else {
        const s = fresh();
        s.pairOld = oldP;
        s.pairNew = newP;
        startSection(s);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // inside a section header, before its first hunk
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${lineNo + 1}`);
      if (line.startsWith('rename from ')) cur.renameFrom = trimSpaces(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.renameTo = trimSpaces(line.slice('rename to '.length));
      else if (line.startsWith('new file mode')) cur.newFileMode = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFileMode = true;
      i += 1;
      continue;
    }
    i += 1; // prose and anything else outside sections and bodies
  }
  finishHunk();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastKept(h: Hunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j -= 1) {
    const k = h.body[j]!.kind;
    if (k === ' ' || k === '+') return h.body[j + 1]?.kind === '\\';
  }
  return false;
}

function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = [...fs.lines];
  let final = fs.final;
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const neu: NewLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        neu.push({ text: b.text, ctx: old.length });
        old.push(b.text);
      } else if (b.kind === '-') {
        old.push(b.text);
      } else if (b.kind === '+') {
        neu.push({ text: b.text, ctx: -1 });
      }
    }
    if (old.length > 0) {
      const m = findMatch(lines, old, strict, 0);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      for (const p of m.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const reachesEnd = pos + old.length === lines.length;
      const repl = buildReplacement(lines, pos, old, neu, m.tier);
      lines = spliceLines(lines, pos, old.length, repl);
      if (reachesEnd) final = !backslashAfterLastKept(h);
    } else {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      const repl = neu.map((n) => n.text);
      lines = spliceLines(lines, pos, 0, repl);
      if (atEnd) final = !backslashAfterLastKept(h);
    }
    d += neu.length - old.length;
  }
  return { lines, br: fs.br, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => {
    const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.gitOld);
    const newP = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.gitNew);
    const isCreate = (oldP === null || s.newFileMode) && newP !== null;
    const isDelete = !isCreate && (newP === null || s.deletedFileMode) && oldP !== null;
    if (isCreate) {
      const p = newP!;
      return (tree: Tree) => {
        if (!safePath(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content: string[] = [];
        let lastPlus: { h: Hunk; j: number } | null = null;
        for (const h of s.hunks) {
          h.body.forEach((b, j) => {
            if (b.kind === '+') {
              content.push(b.text);
              lastPlus = { h, j };
            }
          });
        }
        const noFinal = lastPlus !== null && lastPlus.h.body[lastPlus.j + 1]?.kind === '\\';
        tree.now.set(p, serializeFile(content, '\n', !noFinal));
      };
    }
    if (isDelete) {
      const p = oldP!;
      return (tree: Tree) => {
        if (!safePath(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const o = oldP;
      const n = newP;
      return (tree: Tree) => {
        if (!safePath(o)) throw new Fail('unsafe', o);
        if (!safePath(n)) throw new Fail('unsafe', n);
        const before = tree.get(o);
        if (before === null) throw new Fail('missing', o);
        if (tree.get(n) !== null) throw new Fail('exists', n);
        const out = applyHunks(parseFileText(before), s.hunks, strict, o);
        tree.now.set(n, serializeFile(out.lines, out.br, out.final));
        tree.now.set(o, null);
        tree.moves.push([o, n]);
      };
    }
    const p = oldP ?? newP ?? '';
    return (tree: Tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyHunks(parseFileText(before), s.hunks, strict, p);
      tree.now.set(p, serializeFile(out.lines, out.br, out.final));
    };
  });
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    neu: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  const marker = (l: string, m: string): boolean => l.trimEnd() === m;
  while (i < lines.length) {
    if (!marker(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    const old: string[] = [];
    let j = i + 1;
    while (j < lines.length && !marker(lines[j]!, '=======')) {
      if (marker(lines[j]!, '<<<<<<< SEARCH') || marker(lines[j]!, '>>>>>>> REPLACE')) {
        throw new Exit2(`error: parse ${searchNo}`);
      }
      old.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    j += 1;
    const neu: string[] = [];
    while (j < lines.length && !marker(lines[j]!, '>>>>>>> REPLACE')) {
      if (marker(lines[j]!, '<<<<<<< SEARCH') || marker(lines[j]!, '=======')) {
        throw new Exit2(`error: parse ${searchNo}`);
      }
      neu.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    blocks.push({ path, old, neu });
    prevPath = path;
    prevEnd = j + 1;
    i = j + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, serializeFile(b.neu, '\n', true));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const fs = parseFileText(before);
    const m = findMatch(fs.lines, b.old, strict, 0);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = m.positions[0]!;
    const repl = buildReplacement(fs.lines, pos, b.old, b.neu.map((t) => ({ text: t, ctx: -1 })), m.tier);
    tree.now.set(b.path, serializeFile(spliceLines(fs.lines, pos, b.old.length, repl), fs.br, fs.final));
  });
}

// ---------- section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}
type V4aSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: Chunk[] };

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
const isV4aStart = (l: string): boolean => V4A_STARTS.some((p) => l.startsWith(p));

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const startLine = i + 1;
    let end = i + 1;
    while (end < last && !isV4aStart(lines[end]!)) end += 1;
    // the section's own lines, with trailing blank lines dropped
    const body: { text: string; no: number }[] = [];
    for (let k = i + 1; k < end; k += 1) body.push({ text: lines[k]!, no: k + 1 });
    while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();

    if (line.startsWith('*** Add File: ')) {
      const path = trimSpaces(line.slice('*** Add File: '.length));
      const content: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) content.push(b.text.slice(1));
        else if (b.text === '') content.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      sections.push({ kind: 'add', path, content });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = trimSpaces(line.slice('*** Delete File: '.length));
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      sections.push({ kind: 'delete', path });
    } else if (line.startsWith('*** Update File: ')) {
      const path = trimSpaces(line.slice('*** Update File: '.length));
      let moveTo: string | null = null;
      let k = 0;
      if (k < body.length && body[k]!.text.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(body[k]!.text.slice('*** Move to: '.length));
        k += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let started = false;
      for (; k < body.length; k += 1) {
        const { text: t, no } = body[k]!;
        if (t.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (t.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = trimSpaces(t.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          started = true;
          continue;
        }
        if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, body: [], eof: false };
            started = true;
          }
          cur.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
    } else {
      throw new Exit2(`error: parse ${startLine}`);
    }
    i = end;
  }
  return sections;
}

function applyChunks(fs: FileState, chunks: Chunk[], strict: boolean, path: string): string[] {
  let lines = [...fs.lines];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      // the anchor is a single old line: the first line at or after the cursor
      // equal to it at the first tier where one is (SPEC section 8)
      const m = findMatch(lines, [chunk.anchor], strict, cursor);
      if (m === null) throw new Fail('no-match', path);
      cursor = m.positions[0]! + 1;
    }
    const old: string[] = [];
    const neu: NewLine[] = [];
    for (const t of chunk.body) {
      if (t === '' || t.startsWith(' ')) {
        const text = t === '' ? '' : t.slice(1);
        neu.push({ text, ctx: old.length });
        old.push(text);
      } else if (t.startsWith('-')) {
        old.push(t.slice(1));
      } else {
        neu.push({ text: t.slice(1), ctx: -1 });
      }
    }
    if (old.length > 0) {
      const m = findMatch(lines, old, strict, cursor);
      if (m === null) throw new Fail('no-match', path);
      let positions = m.positions;
      if (chunk.eof) positions = positions.filter((p) => p + old.length === lines.length);
      if (positions.length === 0) throw new Fail('no-match', path);
      const pos = positions[0]!;
      const repl = buildReplacement(lines, pos, old, neu, m.tier);
      lines = spliceLines(lines, pos, old.length, repl);
      cursor = pos + repl.length;
    } else {
      const pos = chunk.eof ? lines.length : cursor;
      const repl = neu.map((n) => n.text);
      lines = spliceLines(lines, pos, 0, repl);
      cursor = pos + repl.length;
    }
  }
  return lines;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((s) => {
    if (s.kind === 'add') {
      return (tree: Tree) => {
        if (!safePath(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, serializeFile(s.content, '\n', true));
      };
    }
    if (s.kind === 'delete') {
      return (tree: Tree) => {
        if (!safePath(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      };
    }
    return (tree: Tree) => {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== null && !safePath(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const fs = parseFileText(before);
      const out = applyChunks(fs, s.chunks, strict, s.path);
      const text = serializeFile(out, fs.br, fs.final);
      if (s.moveTo !== null) {
        tree.now.set(s.moveTo, text);
        tree.now.set(s.path, null);
        tree.moves.push([s.path, s.moveTo]);
      } else {
        tree.now.set(s.path, text);
      }
    };
  });
}

// ---------- section 9: JSON edits ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const fs = parseFileText(before);
      if (line < 0 || line > fs.lines.length) throw new Fail('no-match', p);
      const out = spliceLines(fs.lines, line, 0, add);
      tree.now.set(p, serializeFile(out, fs.br, fs.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- sections 1, 2 and 10: invocation, output, atomicity ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (paired.has(o) || paired.has(n)) continue;
    if (tree.original(o) !== null && tree.state(o) === null && tree.original(n) === null && tree.state(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      paired.add(o);
      paired.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byteCmp(x.key, y.key));
  if (!check) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
