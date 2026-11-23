// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line compared at a tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at a tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const want = o.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with --strict). */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  ctx: boolean;
  text: string;
  oIdx: number;
}

/** O and N of a hunk or chunk body, and whether a `\` line follows its last context or `+` line. */
function buildON(body: string[]): { o: string[]; n: NItem[]; backslashAfterLast: boolean } {
  const o: string[] = [];
  const n: NItem[] = [];
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      o.push('');
      n.push({ ctx: true, text: '', oIdx: o.length - 1 });
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ ctx: true, text: t, oIdx: o.length - 1 });
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ ctx: false, text: l.slice(1), oIdx: -1 });
      lastCtxPlus = k;
    }
  }
  const backslashAfterLast = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]![0] === '\\';
  return { o, n, backslashAfterLast };
}

/** The lines N writes in place of O matched at `pos`: context lines as the file has them, other lines
 *  re-indented at tier 2 (SPEC.md section 5). */
function replacementLines(fileLines: string[], pos: number, o: string[], n: NItem[], tier: number): string[] {
  if (tier === 2 && o.length > 0) {
    const F = /^[ \t]*/.exec(fileLines[pos]!)![0];
    const P = /^[ \t]*/.exec(o[0]!)![0];
    return n.map((it) => {
      if (it.ctx) return fileLines[pos + it.oIdx]!;
      const l = it.text;
      if (l === '' || /^[ \t]+$/.test(l)) return l;
      return l.startsWith(P) ? F + l.slice(P.length) : l;
    });
  }
  return n.map((it) => (it.ctx ? fileLines[pos + it.oIdx]! : it.text));
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: string[];
  o: string[];
  n: NItem[];
  backslashAfterLast: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` header path: text after the four characters, up to the first tab, trimmed,
 *  with one leading `a/` or `b/` removed. */
function headerPath(l: string): string {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const { o, n, backslashAfterLast } = buildON(body);
  return { hunk: { a, body, o, n, backslashAfterLast }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const gitRe = /^diff --git a\/(.*) b\/(.*)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inBody = false;
  const newSection = (): Section => {
    const s: Section = {
      gitOld: null,
      gitNew: null,
      pairOld: null,
      pairNew: null,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inBody = false;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = gitRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || inBody || cur.pairOld !== null) {
        const s = newSection();
        s.pairOld = headerPath(l);
        s.pairNew = headerPath(lines[i + 1]!);
      } else {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !inBody) throw new Exit2(`error: parse ${Math.min(i + 2, lines.length + 1)}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i + 1, parseInt(m[1]!, 10));
      cur.hunks.push(hunk);
      inBody = true;
      i = next;
      continue;
    }
    if (cur !== null && !inBody) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One hunk applied to a file: O replaced by N at the occurrence nearest A - 1 + d, or N inserted
 *  after the first A + d lines when O is empty. */
function applyHunk(f: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  if (h.o.length > 0) {
    const found = findTier(f.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        pos = p;
      }
    }
    const rep = replacementLines(f.lines, pos, h.o, h.n, found.tier);
    const lines = f.lines.slice(0, pos).concat(rep, f.lines.slice(pos + h.o.length));
    const touchesEnd = pos + h.o.length === f.lines.length;
    return { lines, br: f.br, final: touchesEnd ? !h.backslashAfterLast : f.final };
  }
  const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
  const rep = h.n.map((it) => it.text);
  const lines = f.lines.slice(0, idx).concat(rep, f.lines.slice(idx));
  const touchesEnd = idx === f.lines.length;
  return { lines, br: f.br, final: touchesEnd ? !h.backslashAfterLast : f.final };
}

function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let d = 0;
  let cur = f;
  for (const h of hunks) {
    cur = applyHunk(cur, h, d, strict, path);
    d += h.n.length - h.o.length;
  }
  return cur;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.pairOld !== null ? s.pairOld : s.renameFrom !== null ? s.renameFrom : s.gitOld;
  const newPath = s.pairNew !== null ? s.pairNew : s.renameTo !== null ? s.renameTo : s.gitNew;
  const oldP = oldPath === '/dev/null' ? null : oldPath;
  const newP = newPath === '/dev/null' ? null : newPath;
  return (tree: Tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    const isDelete = newP === null || s.deletedFile;
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isCreate = oldP === null || s.newFile;
    if (isCreate) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]![0] === '+') {
            plus.push(h.body[k]!.slice(1));
            lastPlus = { hunk: h, idx: k };
          }
        }
      }
      let final = true;
      if (lastPlus !== null) {
        const b = lastPlus.hunk.body;
        const k = lastPlus.idx;
        final = !(k + 1 < b.length && b[k + 1]![0] === '\\');
      }
      tree.now.set(newP!, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (oldP !== newP) {
      const t = tree.get(oldP!);
      if (t === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const f = applyHunks(parseFile(t), s.hunks, strict, oldP!);
      tree.now.set(newP!, serializeFile(f));
      tree.now.set(oldP!, null);
      tree.recordMove(oldP!, newP!);
      return;
    }
    const t = tree.get(oldP!);
    if (t === null) throw new Fail('missing', oldP!);
    const f = applyHunks(parseFile(t), s.hunks, strict, oldP!);
    tree.now.set(oldP!, serializeFile(f));
  };
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(b.path);
    if (t === null) throw new Fail('missing', b.path);
    const f = parseFile(t);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const items: NItem[] = b.newLines.map((text) => ({ ctx: false, text, oIdx: -1 }));
    const rep = replacementLines(f.lines, pos, b.oldLines, items, found.tier);
    const lines = f.lines.slice(0, pos).concat(rep, f.lines.slice(pos + b.oldLines.length));
    tree.now.set(b.path, serializeFile({ lines, br: f.br, final: f.final }));
  };
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
  o: string[];
  n: NItem[];
}

/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const m = raw[k]!;
        if (m === '') fileLines.push('');
        else if (m[0] === '+') fileLines.push(m.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      const closeChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      while (j < last) {
        const m = lines[j]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('@@')) {
          closeChunk();
          const anchor = m.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [], o: [], n: [] };
          j++;
          continue;
        }
        if (m.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${j + 1}`);
          chunk.eof = true;
          closeChunk();
          j++;
          continue;
        }
        if (m.startsWith('***')) throw new Exit2(`error: parse ${j + 1}`);
        if (m === '' || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
          if (chunk === null) {
            if (chunks.length === 0) {
              chunk = { anchor: null, eof: false, body: [], o: [], n: [] };
            } else if (blank(m)) {
              j++;
              continue;
            } else {
              throw new Exit2(`error: parse ${j + 1}`);
            }
          }
          chunk.body.push(m);
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0 && blank(lc.body[lc.body.length - 1]!)) lc.body.pop();
        if (lc.body.length === 0 && lc.anchor === null && !lc.eof) chunks.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      for (const c of chunks) {
        const { o, n } = buildON(c.body);
        c.o = o;
        c.n = n;
      }
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(t);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const at = findAnchor(f.lines, c.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (c.o.length === 0) {
        const idx = c.eof ? f.lines.length : cursor;
        const rep = c.n.map((it) => it.text);
        f.lines.splice(idx, 0, ...rep);
        cursor = idx + rep.length;
      } else {
        const found = findTierFrom(f.lines, c.o, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        const occ = c.eof ? found.occ.filter((p) => p + c.o.length === f.lines.length) : found.occ;
        if (occ.length === 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        const rep = replacementLines(f.lines, pos, c.o, c.n, found.tier);
        f.lines.splice(pos, c.o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ---- Section 4: detecting the format ---- */

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

/* ---- Section 9: JSON edits ---- */

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
      tree.now.set(p, text);
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
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ---- Sections 1, 2 and 10: invocation, output, order and atomicity ---- */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const byPath = new Map<string, { key: string; line: string }>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const line = was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}`;
    const e = { key: p, line };
    rows.push(e);
    byPath.set(p, e);
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      const d = byPath.get(oldP);
      const a = byPath.get(newP);
      if (d !== undefined) {
        rows.splice(rows.indexOf(d), 1);
        byPath.delete(oldP);
      }
      if (a !== undefined) {
        rows.splice(rows.indexOf(a), 1);
        byPath.delete(newP);
      }
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
