// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the reference build's output tree for every
// input, byte for byte, with substantially less CPU time. Self-contained, dependency-free, Node built-ins only
// (in fact, no imports at all). The semantics of the reference (front matter, template dialect, Markdown subset,
// slug rule, build report) are reproduced exactly; only the machinery is faster:
//   - HTML escaping is a single slice-based pass that returns most strings untouched (the reference escapes with a
//     regex callback, and its inline renderer calls it once per character).
//   - The inline renderer works on index ranges of the original string instead of recursively slicing substrings.
//   - Markdown lexing and rendering are fused into one pass with char-code line classification (no per-line regexes).
//   - slugify is memoized within a build (it is a pure function; nothing is cached from one case to the next).
//   - Front matter is scanned by offsets instead of splitting and re-joining the whole source.
//   - Each page's card is built once and shared by the page, index, tag and recent views.

// ---------------------------------------------------------------- text

const ESC5 = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE_RE = /[&<>"']/;

/** `s` with & < > " and ' escaped; returns `s` itself when there is nothing to escape. */
function escapeStr(s) {
  if (!ESCAPE_RE.test(s)) return s;
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      out = (out === null ? s.slice(0, i) : out + s.slice(start, i)) + rep;
      start = i + 1;
    }
  }
  return out === null ? s : start < s.length ? out + s.slice(start) : out;
}

/** Push s[lo, hi) HTML-escaped onto `out` (an array of chunks), in as few chunks as possible. */
function escapeRange(out, s, lo, hi) {
  let start = lo;
  for (let i = lo; i < hi; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      if (i > start) out.push(s.slice(start, i));
      out.push(rep);
      start = i + 1;
    }
  }
  if (hi > start) out.push(s.slice(start, hi));
}

export const SLUG_MAX = 64;

/** The slug of `text`, exactly as the reference computes it. */
function slugifyRaw(text) {
  // Pure-ASCII text is unchanged by NFKD and holds no combining marks, so it can skip both.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is JavaScript whitespace (the \s class), for word counting and \S tests. */
function isWsCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace (counted, not collected). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Whitespace test with the common cases first: ASCII fast paths, the full \s set only above 127.
    let ws;
    if (c <= 32) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else if (c < 128) ws = false;
    else ws = isWsCode(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

const isLowerKeyChar = (c) => (c >= 97 && c <= 122) || c === 95; // a-z and _
const isNameChar = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45; // a-z 0-9 -

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // Exactly YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters.
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        let i = 0;
        const run = () => {
          const start = i;
          while (i < raw.length) {
            const c = raw.charCodeAt(i);
            if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
            else break;
          }
          return i > start;
        };
        if (!run()) ok = false;
        while (ok && i < raw.length) {
          if (raw.charCodeAt(i) !== 45) {
            ok = false;
            break;
          }
          i++;
          if (!run()) ok = false;
        }
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Scanned by offsets; the body is one slice, never a split and re-join of the whole source.
 */
export function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = firstNl + 1;
  let bodyStart = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd === pos + 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(text.slice(pos, lineEnd));
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    // Blank (spaces and tabs only) or a comment.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and _, a colon, then either the end or one space and the value.
    let k = 0;
    while (k < line.length && isLowerKeyChar(line.charCodeAt(k))) k++;
    let raw;
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    // The value's trailing spaces and tabs are dropped.
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    if (end !== raw.length) raw = raw.slice(0, end);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appended to the chunk array `out`. `ctx` holds the parsed templates. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeStr(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** An include, rendered by the compiled templates: the named template in the same scope, at most 8 deep. */
function renderInclude(name, scope, ctx, depth, out) {
  const f = ctx.fns.get(name);
  if (f !== undefined && depth < INCLUDE_DEPTH) f(scope, ctx, depth + 1, out);
}

const HELPERS = { L: lookup, T: textOf, Y: truthy, E: escapeStr, R: renderInclude };

/**
 * A template's nodes compiled to a specialized render function (the same walk renderNodes makes, with the node
 * dispatch, path arrays and literal text inlined). Pure JavaScript source generation from the entry's own parsed
 * templates; nothing external is loaded.
 */
function compileTemplate(nodes) {
  const paths = [];
  const pathIds = new Map();
  const pathId = (path) => {
    const key = path.join('\u0001');
    let id = pathIds.get(key);
    if (id === undefined) {
      id = paths.length;
      paths.push(path);
      pathIds.set(key, id);
    }
    return id;
  };
  let counter = 0;
  const gen = (list, S) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `out.push(${JSON.stringify(n.text)});`;
          break;
        case 'var':
          code += `out.push(H.E(H.T(H.L(${S},P${pathId(n.path)}))));`;
          break;
        case 'raw':
          code += `out.push(H.T(H.L(${S},P${pathId(n.path)})));`;
          break;
        case 'if': {
          const p = pathId(n.path);
          code += `if(H.Y(H.L(${S},P${p}))!==${n.not}){${gen(n.then, S)}}`;
          if (n.else !== null) code += `else{${gen(n.else, S)}}`;
          break;
        }
        case 'for': {
          const q = counter++;
          const p = pathId(n.path);
          const child = `S${q}`;
          code +=
            `{const X${q}=H.L(${S},P${p});if(Array.isArray(X${q})){const N${q}=X${q}.length;` +
            `for(let I${q}=0;I${q}<N${q};I${q}++){const ${child}={vars:{[${JSON.stringify(n.name)}]:X${q}[I${q}],` +
            `loop:{index:I${q}+1,first:I${q}===0,last:I${q}===N${q}-1,length:N${q}}},parent:${S}};${gen(n.body, child)}}}}`;
          break;
        }
        case 'include':
          code += `H.R(${JSON.stringify(n.name)},${S},ctx,depth,out);`;
          break;
      }
    }
    return code;
  };
  const body = gen(nodes, 'S');
  const consts = paths.map((p, i) => `const P${i}=${JSON.stringify(p)};`).join('');
  const factory = new Function('H', `${consts}return function(S,ctx,depth,out){${body}};`);
  return factory(HELPERS);
}

/** A template's renderer: its compiled function, or the interpreter when compilation is unavailable. */
function compileOrInterpret(nodes) {
  try {
    return compileTemplate(nodes);
  } catch {
    return (scope, ctx, depth, out) => renderNodes(nodes, scope, ctx, depth, out);
  }
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, as a table over char codes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;

/** The first index in [from, hi) where s holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j + wlen <= hi; j++) {
    if (s[j] === '\\' && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** s[lo, hi) rendered inline onto the chunk array `out`; `env.link(target)` is a link's href. */
function inlineInto(s, lo, hi, env, out) {
  let i = lo;
  let run = lo;
  while (i < hi) {
    const c = s[i];
    if (c !== '\\' && c !== '`' && c !== '*' && c !== '[') {
      // A plain stretch: jump straight to the next character that can open a construct (native search, not a
      // per-character walk). Occurrences at or past hi do not count.
      let j = hi;
      let k = s.indexOf('\\', i + 1);
      if (k !== -1 && k < j) j = k;
      k = s.indexOf('`', i + 1);
      if (k !== -1 && k < j) j = k;
      k = s.indexOf('*', i + 1);
      if (k !== -1 && k < j) j = k;
      k = s.indexOf('[', i + 1);
      if (k !== -1 && k < j) j = k;
      i = j;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
        if (i > run) escapeRange(out, s, run, i);
        const n = s[i + 1];
        out.push(ESC5[n] ?? n);
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j >= hi) j = -1;
      if (j > i + 1) {
        if (i > run) escapeRange(out, s, run, i);
        out.push('<code>');
        escapeRange(out, s, i + 1, j);
        out.push('</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          if (i > run) escapeRange(out, s, run, i);
          out.push('<strong>');
          inlineInto(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        if (i > run) escapeRange(out, s, run, i);
        out.push('<em>');
        inlineInto(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      let target = '';
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m >= hi) m = -1;
        if (m !== -1) target = s.slice(k + 2, m);
      }
      if (m !== -1 && target !== '' && !WS_RE.test(target)) {
        if (i > run) escapeRange(out, s, run, i);
        out.push('<a href="');
        out.push(escapeStr(env.link(target)));
        out.push('">');
        inlineInto(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (hi > run) escapeRange(out, s, run, hi);
}

/** Render s (a whole inline context: a paragraph, heading text, list item...) to its HTML string. */
function inlineString(s, env) {
  const out = [];
  inlineInto(s, 0, s.length, env, out);
  return out.join('');
}

const isSpaceTab = (c) => c === 32 || c === 9;

/** A line of nothing but spaces and tabs (or empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A line with its leading and trailing spaces and tabs dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

const isLangChar = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** A fence-opening line's language, or null when the line opens no fence. */
function fenceOpenLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (!isSpaceTab(line.charCodeAt(i))) return null;
    i++;
  }
  return lang;
}

/** A fence-closing line: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (!isSpaceTab(line.charCodeAt(d))) return null;
  let i = d;
  while (i < line.length && isSpaceTab(line.charCodeAt(i))) i++;
  let end = line.length;
  while (end > i && isSpaceTab(line.charCodeAt(end - 1))) end--;
  if (end === i) return null;
  return { depth: d, text: line.slice(i, end) };
}

/** A thematic break: exactly --- or ***, then spaces or tabs only. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** Line kinds for the Markdown pass: each line is classified once, then read from the table. */
const LK_BLANK = 1;
const LK_FENCE = 2;
const LK_HEADING = 3;
const LK_HR = 4;
const LK_QUOTE = 5;
const LK_OTHER = 6;

/** Whether a line of this kind ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraphKind(kind) {
  return kind === LK_BLANK || kind === LK_FENCE || kind === LK_HEADING || kind === LK_HR;
}

/** A bullet item's text, or null: "- " or "* ", then anything. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's { num, text }, or null: 1 to 9 digits, ". ", then anything. */
function orderedMatch(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  return i < line.length && !isWsCode(line.charCodeAt(i));
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after the last), its table of contents
 * (every level 2 and 3 heading) and its excerpt (the first paragraph's inline HTML, or ""). `env.link` resolves a
 * link's href and `env.slug` is the build's memoized slugify.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  // Lines are classified lazily, once each (blank, fence, heading, break, quote), and the classification is
  // cached: the block walk and the paragraph-end test both read it instead of re-testing lines, and lines a
  // fence swallows are never classified at all.
  const kinds = new Int8Array(n);
  const langs = new Array(n);
  const heads = new Array(n);
  const kindAt = (i) => {
    let k = kinds[i];
    if (k === 0) {
      const line = lines[i];
      if (isBlank(line)) k = LK_BLANK;
      else {
        const lang = fenceOpenLang(line);
        if (lang !== null) {
          k = LK_FENCE;
          langs[i] = lang;
        } else {
          const h = headingOf(line);
          if (h !== null) {
            k = LK_HEADING;
            heads[i] = h;
          } else if (isHR(line)) k = LK_HR;
          else if (line.charCodeAt(0) === 62) k = LK_QUOTE;
          else k = LK_OTHER;
        }
      }
      kinds[i] = k;
    }
    return k;
  };
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const kind = kindAt(i);
    const line = lines[i];
    if (kind === LK_BLANK) {
      i++;
      continue;
    }
    if (kind === LK_FENCE) {
      const lang = langs[i];
      out.push('<pre><code');
      if (lang !== '') {
        out.push(' class="language-');
        out.push(escapeStr(lang));
        out.push('"');
      }
      out.push('>');
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        out.push(escapeStr(lines[i]));
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === LK_HEADING) {
      const heading = heads[i];
      const id = uniqueSlug(env.slug(heading.text), ids);
      const html = inlineString(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === LK_HR) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (kind === LK_QUOTE) {
      const kept = [];
      while (i < n && kindAt(i) === LK_QUOTE) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        i++;
        const tr = trimLine(t);
        if (tr !== '') kept.push(tr);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const b0 = bulletText(line);
    const o0 = b0 === null ? orderedMatch(line) : null;
    if (b0 !== null || o0 !== null) {
      const ordered = o0 !== null;
      const items = [];
      let cur = null;
      while (i < n) {
        const l = lines[i];
        const m = ordered ? orderedMatch(l) : null;
        const bt = ordered ? null : bulletText(l);
        if (ordered ? m !== null : bt !== null) {
          cur = [trimLine(ordered ? m.text : bt)];
          items.push(cur);
          i++;
        } else if (cur !== null && isContinued(l)) {
          cur.push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && o0.num !== 1 ? `<ol start="${o0.num}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        const itemText = parts.join('\n');
        out.push('<li>');
        inlineInto(itemText, 0, itemText.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraphKind(kindAt(i))) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const text = body.join('\n');
    out.push('<p>');
    if (excerpt === null) {
      const parts = [];
      inlineInto(text, 0, text.length, env, parts);
      excerpt = parts.join('');
      out.push(excerpt);
    } else inlineInto(text, 0, text.length, env, out);
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `t` opens with a URI scheme (^[A-Za-z][A-Za-z0-9+.-]*:). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` resolved against `dirParts` (the segments of a source's directory), or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? b.slugMemo(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      slug: b.slugMemo,
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null) {
          const page = b.bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        }
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

function tags(b) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = b.slugMemo(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = b.slugMemo(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = b.slugMemo(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) =>
  s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(b, s) {
  return {
    ...b.cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function layouts(b) {
  // Every source's card is built once and shared by its page, the index, the tag pages and `recent`.
  b.cards = new Map();
  for (const s of b.sources) b.cards.set(s, cardOf(s));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, fns: b.fns };
  // site, tags and recent are the same for every render of the build: one shared base scope under each render's
  // own vars (a render's vars hold only page / posts+pager / tag, which never shadow the base names).
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const fn = b.fns.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pages = 0;
  for (const s of b.sources) if (!s.post) pages++;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. Exactly makefun-site 1.0.0's answer for the input. */
export function build(input) {
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const fns = new Map();
  for (const [name, nodes] of templates) fns.set(name, compileOrInterpret(nodes));
  const memo = new Map();
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    fns,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugMemo: (text) => {
      let slug = memo.get(text);
      if (slug === undefined) {
        slug = slugifyRaw(text);
        memo.set(text, slug);
      }
      return slug;
    },
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
