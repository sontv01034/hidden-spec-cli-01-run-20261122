// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none. The contract is
// SPEC.md in this repository. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// When MAKEFUN_ENV_URL is set this file hands the trial over to runner.ts
// (the last lines below): the runner reads the trial's checks from the env,
// runs this file on each one, and posts what it did.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse/usage/format failure: exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1, one `error: <code> <path>` line. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitText(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinText(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A line as a tier sees it. */
function norm(s: string, tier: number): string {
  if (tier === 1) return stripTrail(s);
  if (tier === 2) return stripBoth(s);
  return s;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, as (old path, new path) pairs. */
  readonly moves: Array<[string, string]> = [];
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
  /** The file at p as lines, or null when it does not exist. */
  lines(p: string): FileState | null {
    const t = this.get(p);
    return t === null ? null : splitText(t);
  }
  setLines(p: string, f: FileState): void {
    this.now.set(p, joinText(f));
  }
  setText(p: string, text: string): void {
    this.now.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

/** Positions where O occurs in lines at a tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (norm(lines[i + k]!, tier) !== norm(o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: `ctx` is the index into O when it is a context line, else null. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Re-indent one non-context line of N at tier 2: F is the leading spaces and
 * tabs of the file's first matched line, P those of O's first line.
 */
function reindent(text: string, tier: number, firstFileLine: string, firstOldLine: string): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  const p = leadWs(firstOldLine);
  if (!text.startsWith(p)) return text;
  return leadWs(firstFileLine) + text.slice(p.length);
}

/** Replace O at `pos` by N: context lines come from the file's own lines. */
function replaceAt(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  for (const nl of n) {
    out.push(nl.ctx !== null ? lines[pos + nl.ctx]! : reindent(nl.text, tier, lines[pos]!, o[0]!));
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.setText(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.setText(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitText(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.setLines(p, f);
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
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
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** One body line of a hunk or chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  /** True when the raw patch line was empty (a context line with empty text). */
  empty: boolean;
}

/** One hunk: its old start line, its old and new lines, and whether a `\` line follows its last context or `+` line (and its last `+` line). */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** null when the hunk has no context or `+` line. */
  noBreak: boolean | null;
  /** null when the hunk has no `+` line. */
  noBreakPlus: boolean | null;
}

/** The O and N of a hunk or chunk body, with context lines marked. */
function bodyON(body: BodyLine[]): { o: string[]; n: NLine[]; noBreak: boolean | null; noBreakPlus: boolean | null } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxNew = -1;
  let lastNew = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: o.length });
      o.push(b.text);
      lastCtxNew = i;
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
      lastCtxNew = i;
      lastNew = i;
    }
  });
  const noBreak = lastCtxNew < 0 ? null : body[lastCtxNew + 1]?.kind === 'mark';
  const noBreakPlus = lastNew < 0 ? null : body[lastNew + 1]?.kind === 'mark';
  return { o, n, noBreak, noBreakPlus };
}

/** Apply one hunk to a file; `d` is the length drift of this section's hunks applied so far. */
function applyHunk(f: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  if (h.o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, f.lines.length));
    const lines = [...f.lines.slice(0, at), ...h.n.map((x) => x.text), ...f.lines.slice(at)];
    let fin = f.fin;
    if (at === f.lines.length && h.n.length > 0) fin = !(h.noBreak ?? false);
    return { lines, br: f.br, fin };
  }
  const found = findTier(f.lines, h.o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const lines = replaceAt(f.lines, pos, h.o, h.n, found.tier);
  let fin = f.fin;
  if (pos + h.o.length - 1 === f.lines.length - 1) fin = !(h.noBreak ?? false);
  return { lines, br: f.br, fin };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading `a/` or `b/` removed; `/dev/null` is null. */
function patchPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

interface Section {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headerPaths = false;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  const finishSection = (): void => {
    if (cur === null) return;
    if (!headerPaths) {
      if (renameOld !== null) cur.oldP = renameOld;
      if (renameNew !== null) cur.newP = renameNew;
    }
    cur = null;
    headerPaths = false;
    renameOld = null;
    renameNew = null;
    inHeader = false;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = { oldP: m[1]!, newP: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !headerPaths) {
        cur.oldP = patchPath(line);
        cur.newP = patchPath(lines[i + 1]!);
        headerPaths = true;
        i += 2;
        continue;
      }
      finishSection();
      cur = { oldP: patchPath(line), newP: patchPath(lines[i + 1]!), create: false, del: false, hunks: [] };
      sections.push(cur);
      headerPaths = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', empty: true });
          j += 1;
        } else if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push({
            kind: bl[0] === ' ' ? 'ctx' : bl[0] === '-' ? 'old' : bl[0] === '+' ? 'new' : 'mark',
            text: bl.slice(1),
            empty: false,
          });
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      const { o, n: nn, noBreak, noBreakPlus } = bodyON(body);
      cur.hunks.push({ a: Number(m[1]), o, n: nn, noBreak, noBreakPlus });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  finishSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified section as an edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  const isCreate = s.oldP === null || s.create;
  const isDelete = !isCreate && (s.newP === null || s.del);
  const isMove = !isCreate && !isDelete && s.oldP !== null && s.newP !== null && s.oldP !== s.newP;
  return (tree) => {
    if (isCreate) {
      const p = s.newP!;
      if (p === null) throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.n) {
          if (b.ctx === null) plus.push(b.text);
        }
      }
      // The creation ends with a line break unless a `\` line follows its last `+` line.
      let noBreak = false;
      for (const h of s.hunks) {
        if (h.n.some((b) => b.ctx === null)) noBreak = h.noBreakPlus ?? false;
      }
      tree.setText(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = s.oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const oldP = s.oldP!;
      const newP = s.newP!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const f = tree.lines(oldP);
      if (f === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let cur = f;
      let d = 0;
      for (const h of s.hunks) {
        cur = applyHunk(cur, h, d, strict, oldP);
        d += h.n.length - h.o.length;
      }
      tree.setLines(newP, cur);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = s.oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const f = tree.lines(p);
    if (f === null) throw new Fail('missing', p);
    let cur = f;
    let d = 0;
    for (const h of s.hunks) {
      cur = applyHunk(cur, h, d, strict, p);
      d += h.n.length - h.o.length;
    }
    tree.setLines(p, cur);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.setText(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const f = tree.lines(path);
    if (f === null) throw new Fail('missing', path);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const n: NLine[] = newLines.map((text) => ({ text, ctx: null }));
    tree.setLines(path, { lines: replaceAt(f.lines, pos, oldLines, n, found.tier), br: f.br, fin: f.fin });
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let p = searchIdx - 1; p > prevEnd; p -= 1) {
      const l = lines[p]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, j), lines.slice(j + 1, k), strict));
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** Apply one V4A chunk; the cursor starts at `cursor` and moves past the lines written. */
function applyChunk(f: FileState, c: Chunk, cursor: number, strict: boolean, path: string): { file: FileState; cursor: number } {
  let cur = cursor;
  if (c.anchor !== null && c.anchor !== '') {
    let idx = -1;
    for (const t of strict ? [0] : [0, 1, 2]) {
      for (let i = cur; i < f.lines.length; i += 1) {
        if (norm(f.lines[i]!, t) === norm(c.anchor, t)) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) break;
    }
    if (idx < 0) throw new Fail('no-match', path);
    cur = idx + 1;
  }
  const { o, n } = bodyON(c.body);
  if (o.length === 0) {
    const at = c.eof ? f.lines.length : cur;
    const lines = [...f.lines.slice(0, at), ...n.map((x) => x.text), ...f.lines.slice(at)];
    return { file: { lines, br: f.br, fin: f.fin }, cursor: at + n.length };
  }
  let found: { tier: number; pos: number } | null = null;
  for (const t of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(f.lines, o, t, cur).filter((p) => !c.eof || p + o.length - 1 === f.lines.length - 1);
    if (occ.length > 0) {
      found = { tier: t, pos: occ[0]! };
      break;
    }
  }
  if (found === null) throw new Fail('no-match', path);
  const lines = replaceAt(f.lines, found.pos, o, n, found.tier);
  return { file: { lines, br: f.br, fin: f.fin }, cursor: found.pos + n.length };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: /.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = line.slice(m[0].length).trim();
    let j = i + 1;
    const raw: string[] = [];
    while (j < end) {
      const l2 = lines[j]!;
      if (l2.startsWith('*** Add File: ') || l2.startsWith('*** Delete File: ') || l2.startsWith('*** Update File: ')) break;
      raw.push(l2);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const absLine = (k: number): number => i + 2 + k;
    if (kind === 'Add') {
      const fileLines: string[] = [];
      raw.forEach((l, k) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${absLine(k)}`);
      });
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.setText(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'Delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${absLine(k)}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (idx < raw.length) {
        const l = raw[idx]!;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          idx += 1;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${absLine(idx)}`);
          cur.eof = true;
          cur = null;
          idx += 1;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length !== 0) throw new Exit2(`error: parse ${absLine(idx)}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({
            kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
            text: l === '' ? '' : l.slice(1),
            empty: l === '',
          });
          idx += 1;
        } else {
          throw new Exit2(`error: parse ${absLine(idx)}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const f = tree.lines(path);
        if (f === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let curFile = f;
        let cursor = 0;
        for (const c of chunks) {
          const r = applyChunk(curFile, c, cursor, strict, path);
          curFile = r.file;
          cursor = r.cursor;
        }
        if (moveTo !== null) {
          tree.setLines(moveTo, curFile);
          tree.now.set(path, null);
          tree.moves.push([path, moveTo]);
        } else {
          tree.setLines(path, curFile);
        }
      });
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// The command line (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

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
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The changed paths, with a move's `D` and `A` lines replaced by one `R` line
  // when the old path existed before the patch and does not after it, and the
  // new path did not exist before it and does after it.
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (used.has(oldP) || used.has(newP)) continue;
    if (tree.original(oldP) === null || tree.now.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.now.get(newP) === null) continue;
    if (changed.get(oldP) !== 'D' || changed.get(newP) !== 'A') continue;
    used.add(oldP);
    used.add(newP);
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  for (const [p, kind] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${kind} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
