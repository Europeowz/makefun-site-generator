# Entry: site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0. `main.ts` is the kit's driver, unchanged (it sets
`--no-incremental-marking`, reads `/input/cases.json`, answers each case with `run()` from `solve.js`, writes
`/output/answers.json`). All of the work is in `solve.js`: a single, dependency-free ES module (no imports at all)
that re-implements `build(input)` with the reference's exact semantics — front matter grammar and refusal reasons,
template dialect and parse errors, Markdown subset, slug rule, link resolution, collections/tags, build report —
and returns the same output tree, byte for byte, for every input.

## Optimization approach

Profile of the reference (Node CPU profile over the practice set): `escapeHtml` ~24% (a regex replace with a
callback, called **once per character** by the inline renderer), inline rendering ~9%, Markdown lex/render ~7%,
template rendering ~9%, `wordsOf`'s `/\S+/g` match ~3%, plus ~8% GC from substring slicing. The entry attacks
each, without changing any output semantics:

- **Escaping**: one slice-based pass (`escapeStr`/`escapeRange`) that returns most strings untouched (regex
  early-out) and copies only the spans between special characters, instead of a regex callback per character.
- **Inline renderer**: works on index ranges `[lo, hi)` of the original string instead of recursively slicing
  substrings; plain stretches are skipped with native `indexOf` jumps to the next construct character
  (``\``, `` ` ``, `*`, `[`); construct searches (`findUnescaped`, `findSingleStar`) are range-bounded ports of
  the reference's, with identical escape handling.
- **Markdown**: lexing and rendering fused into a single pass; lines are classified once (lazily, cached in a
  table — fence body lines are never classified) with char-code tests instead of the reference's per-line
  regexes; `trimLine` is an index scan, not a regex replace; block HTML streams into one chunk array.
- **Templates**: each parsed template is compiled once per build into a specialized render function (the node
  dispatch, literal text and path arrays inlined; loop scopes, `lookup`, `textOf`, `truthy`, include-depth
  semantics identical to the reference interpreter, which remains as a fallback if compilation is unavailable).
  Compilation is plain JavaScript source generation from the entry's own parsed templates — no WebAssembly, no
  native code, nothing loaded. `site`/`tags`/`recent` live in one shared base scope instead of being re-merged
  into a fresh vars object per render.
- **Front matter**: scanned by offsets (the body is a single slice) instead of splitting and re-joining the
  whole source; the per-key value grammars are char-code scanners with the reference's exact error strings and
  precedence.
- **Pipeline**: `slugify` memoized within a build (a pure function; nothing is cached from one case to the
  next — the memo is created inside `build()`); each page's card built once and shared by its page, the index,
  tag pages and `recent` (the reference builds post cards twice); `wordsOf` counts word runs with an inlined
  whitespace test instead of building a match array; link resolution reuses the source directory's segments and
  a char-code scheme test instead of two regexes and repeated `split('/')`; sources without `\r` skip the
  line-ending replace.

## Verification (local, Node v24.22.1, this machine)

- **Practice set** (kit `practice/`, 3 cases, 1,135 output files): answers **byte-for-byte identical** to the
  kit's `practice/reference/expected.json` on all 3 cases (JSON-value comparison, key order canonicalized).
- **Generator fuzz**: 36 further cases generated with the kit's own subject generator (`sites.mjs` +
  `streamFor`, fresh seeds — the same code and distribution the scored set is drawn from): **36/36 identical**
  to the reference build.
- **Handcrafted edge suites** (12 inputs): inline/block/front-matter torture (escapes, unclosed constructs,
  every refusal reason, leap dates, quoted-string escapes), structure torture (slug collisions, reserved
  directories, shadowed statics, broken/relative/fragment links, Unicode titles and heading ids), template
  torture (unclosed/mismatched tags, self-includes past depth 8, a loop variable named `loop`, includes inside
  loops, shadowed globals), empty/minimal sites, base_url `''` and `'///'`: **all identical**.

## CPU time vs the reference (same machine, same practice input)

Whole process (`node main.ts`, child user+sys CPU, median of runs):

| entry | CPU |
| --- | --- |
| house baseline (kit `baselines/makefun-site/`) | ~2,575 ms |
| this entry | ~1,500–1,600 ms |

`run()` only (the three practice cases summed, alternating A/B rounds):

| round | baseline | this entry |
| --- | --- | --- |
| 1 | 1,921 ms | 862 ms |
| 2 | 2,150 ms | 1,021 ms |
| 3 | 2,250 ms | 1,117 ms |

So roughly **2.0–2.2× less CPU in `run()`**, ~1.6–1.7× for the whole process (the rest is the shared driver's
JSON parse/stringify and Node startup, which the harness's do-nothing control largely nets out).

## Caveats

- Measured locally on Node v24.22.1 on a shared, noisy VM (run-to-run spread ±10–15%); the sandbox runs
  Node 22 on 1 dedicated CPU, so absolute numbers will differ — the relative gap is what carries over.
- Unicode slug normalization uses this Node's `normalize('NFKD')`, exactly as the reference does; the rules
  state a slug's normalization is the sandbox Node 22's, and both programs call the same runtime primitive.
- If `new Function` were unavailable in the sandbox, the entry falls back to its interpreter renderer
  (identical output, somewhat slower); every other optimization is independent of code generation.
- The scored set is drawn from a later drand round and cannot be tested against; equality assurance rests on
  the practice set, the 36-case generator fuzz, and the edge suites above — all run against the reference
  implementation itself, not just the published practice answers.
- Nothing was submitted anywhere; this directory is the complete, ready entry (`solve.js`, `main.ts`,
  `package.json`, `LICENSE`, `.makefun/owner.json`), ~46 KB total, well under the 4 MiB repository limit.
