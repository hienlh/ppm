# Phase 02: Avatar Utilities

## Overview
- **Priority:** High (blocks Phase 3)
- **Status:** complete

Create `src/web/lib/project-avatar.ts` — pure utility for computing project avatar initials. Color comes from Phase 01's `resolveProjectColor()` (palette by index), not computed here.

## Requirements

### Initials logic
```
Input: list of ALL project names + target project name
Output: 1–2 char string or index number

Algorithm:
1. Extract initials: split name by [-_. ] → take first char of each word → uppercase
   "my-project" → "MP", "api" → "A", "ppm-web" → "PW"
2. Use first char only ("M", "A", "P")
3. If collision with another project → use full initials (2+ chars, max 2)
4. If still collision → use 1-based index in the ordered list
```

## Related Code Files
- Create: `src/web/lib/project-avatar.ts`
- Uses: `src/web/lib/project-palette.ts` (from Phase 01)

## Implementation Steps

1. Implement `getProjectInitials(name: string, allNames: string[]): string`
   - Split by `/[-_.\s]/`
   - Build 1-char candidate → check uniqueness → try 2-char → fall back to index
2. Export convenience wrapper `getProjectAvatar(name, allNames, color)` — returns `{ initials, color }`
   - `color` is passed in from caller (resolved via `resolveProjectColor` from Phase 01)

## Todo

- [ ] `getProjectInitials` with collision resolution
- [ ] `getProjectAvatar` convenience wrapper

## Success Criteria
- Collisions resolved correctly: 1 char → 2 chars → index
- No color logic in this file (delegated to `project-palette.ts`)
