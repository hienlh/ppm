# Git Graph Algorithm Port: SVG Rendering Faithful to vscode-git-graph

**Date**: 2026-04-14 14:52
**Severity**: High
**Component**: ext-git-graph WebView
**Status**: Resolved

## What Happened

Completed faithful port of vscode-git-graph `graph.ts` SVG rendering algorithm into PPM's ext-git-graph extension. Previous implementation was a from-scratch rewrite that stripped out critical features entirely: no continuous lines between commits, no merge routing logic, no HEAD/stash styling, no shadow lines for depth.

The port restored full feature parity with the original while adapting for PPM's commit model and mobile layout requirements.

## The Brutal Truth

This was frustrating because the previous implementation _looked_ functional at first glance — it rendered some boxes and lines — but fundamentally misunderstood how git graph visualization works. When you have multiple branches interleaving, you can't just draw independent vertical lines per commit. You need intelligent path routing to:
- Avoid visual collisions at merge points
- Reuse column assignments across the graph
- Transition smoothly between lane positions with curves
- Visually distinguish shadow (background) vs active (foreground) paths

Spending days on a rewrite that missed all this was inefficient. Should have deconstructed vscode-git-graph from day one instead of guessing.

The real kick is that the algorithm's complexity made sense only after reading the original code. No amount of visual inspection of the original output would have revealed why it worked — the graph determinism is in the column allocation and path-finding, not just drawing code.

## Technical Details

### Porting Scope

**Implemented faithfully:**
- `GBranch`, `GVertex`, `GEdge` data structures
- `determinePath(from, to, availableColours)` — core routing algorithm
- `graphGetAvailableColour(graph, row, col)` — column reuse across rows
- Bézier curve transitions with `d = 0.8 × gridY` control point offset
- Shadow lines: thicker, semi-transparent paths behind colored paths
- HEAD node: hollow circle with branch label
- Stash node: nested circles (outer for stash, inner for commit)
- Commit dot centering in column with optional border ring

**Intentionally skipped (not needed for PPM):**
- `onlyFollowFirstParent` filter mode
- `UNCOMMITTED` virtual commit node
- Circle-at-checkout indicator (PPM uses different HEAD semantics)
- `--all` ref filtering (PPM loads fixed commit range)

**Adapted for PPM:**
- Stash detection: `state.stashes` Set instead of `commit.stash` boolean (PPM model)
- Grid config: `{ x: 16, y: 28, gridX: 8, gridY: 14 }` — compact for table row height
- Mobile SVG: viewport width detection, gridY 28→44px on mobile for touch targets

### Bugs Fixed During Implementation

**Critical: Dot Misalignment (1px per row cumulative)**

`.col-graph` had explicit `height: 28px` styling. Parent had `box-sizing: border-box` with `1px border`. This created:
```
Parent min-height: 28px (includes border)
  → Content box: 27px (28 - 1px border)
Row parent expanded to 29px to fit
SVG used 28px intervals
Result: 1px drift cumulative, visible misalignment by row 10+
```

Fix: Removed explicit `height`, let flexbox handle alignment. SVG uses computed row height.

**High: Path Scope Rejection**

Extensions couldn't execute git in user project directories. `assertSafePath` in `extension-rpc-handlers.ts` only allowed CWD and `~/.ppm/extensions/`. User projects were rejected.

```typescript
// Before
if (cwd !== CWD && !cwd.startsWith(PPM_EXTENSIONS_DIR)) {
  throw new Error("Path not allowed");
}

// After
if (!isAllowedPath(cwd, [CWD, PPM_EXTENSIONS_DIR, ...registeredProjectPaths])) {
  throw new Error("Path not allowed");
}
```

**Medium: XSS in Detail Panel**

Parent hashes and file status inserted into innerHTML without escaping. User with special chars in file path (e.g., `test<img onerror="alert('xss')">`) would execute.

Fix: Used `textContent` for data, `innerHTML` for formatted markup only.

**Medium: Regex Ordering in formatCommitMessage**

URL regex ran before hash regex. URLs like `https://github.com/user/repo/commit/abc123` would partially match hash pattern, creating nested HTML tags.

```typescript
// Before: [urlRegex, hashRegex]
// "https://github.com/.../commit/abc123" → hash regex matched "abc123" inside URL match

// After: [hashRegex, urlRegex]
// Hash captured first, URL captures remaining text
```

## What We Tried

1. **Incremental line-by-line port** — too manual, errors in transcription
2. **Type-driven porting** — created interfaces matching vscode-git-graph `GVertex`, `GBranch` — this worked; types guided implementation
3. **Test-driven validation** — wrote tests for `determinePath` against known graph structures from vscode-git-graph repo — caught routing bugs early
4. **Visual diff** — side-by-side video of original vs PPM output, frame-by-frame comparison at merge points — identified misaligned dots

## Root Cause Analysis

The previous rewrite failed because:
1. **Assumed simplicity** — git graph looked like "connect the dots" instead of a constrained layout problem
2. **No algorithm study** — didn't read vscode-git-graph source before coding; reverse-engineered from output only
3. **Incomplete feature list** — shadow lines, HEAD styling, merge routing logic were invisible until you needed them
4. **No test fixtures** — built without reference commits to validate against

The SVG dot misalignment was a cascade: explicit height forcing a mismatch between CSS row size and SVG coordinate system. `box-sizing: border-box` made the issue subtle — 28px height looked right until it didn't.

Path scope was security-by-assumption — extending permissions to extensions should have been part of original design, not a bandage.

## Lessons Learned

1. **Port, don't rewrite** — When reimplementing an algorithm from proven code, read the original first. Guessing costs more than transcription.

2. **Constrained layout problems need algorithm study** — Graph layout, routing, and column allocation aren't intuitive. Trace through examples before coding.

3. **CSS height mismatches are invisible at first** — When CSS-defined height meets SVG coordinate system, they must align explicitly. Don't rely on browser rendering to fix 1px errors; they compound.

4. **Security permissions evolve with features** — Extensions need project access; this wasn't a later concern, it was a design gap. Build permission model upfront.

5. **Test against canonical output** — Generate test cases from the original algorithm, not from guessed behavior. Side-by-side comparison is necessary, not optional.

## Next Steps

1. **Monitor visual regression** — Run vscode-git-graph test repo against PPM output quarterly to catch algorithm drift
2. **Document grid config** — Add comments explaining `gridY: 28` choice and mobile override, so future maintainers understand dependencies
3. **Consider performance** — Profile SVG rendering with 500+ commits; may need canvas or virtualization for large repos
4. **Security audit** — Review all extension RPC handlers for similar path scope issues

---

**Commit**: `24ad424` feat(ext-git-graph): port vscode-git-graph algorithm with faithful SVG rendering

**Tests**: 62/62 passing (4 test files)

**Review**: 3 critical, 2 high, 4 medium findings — all critical/high addressed before merge
