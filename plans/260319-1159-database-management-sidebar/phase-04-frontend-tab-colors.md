# Phase 4: Frontend — Tab Styling (Colors, Contrast)

## Priority: Medium | Effort: S | Status: Complete
## Depends on: Phase 3 ✓

## Overview
When a connection has a custom color, tabs opened from that connection display the color as background. Tab text auto-contrasts (white on dark, dark on light).

## Key Insights
- `DraggableTab` component (`draggable-tab.tsx`) renders each tab button with Tailwind classes
- Tab metadata already carries `connectionColor` from Phase 3
- Need a pure utility function for luminance-based contrast detection

## Related Code Files

### Modify
- `src/web/components/layout/draggable-tab.tsx` — apply background color + contrast text from metadata
- `src/web/components/layout/tab-bar.tsx` — pass tab metadata to DraggableTab

### Create
- `src/web/lib/color-utils.ts` — contrast detection utility

## Color Contrast Logic

```typescript
// src/web/lib/color-utils.ts

/** Parse hex color to RGB */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null

/** Calculate relative luminance (WCAG 2.0) */
function getLuminance(r: number, g: number, b: number): number

/** Returns true if the color is "dark" (needs white text) */
export function isDarkColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return getLuminance(rgb.r, rgb.g, rgb.b) < 0.5;
}
```

## DraggableTab Changes

```tsx
// In draggable-tab.tsx
const tabColor = tab.metadata?.connectionColor as string | undefined;
const colorStyle = tabColor ? {
  backgroundColor: isActive ? tabColor : `${tabColor}33`, // full opacity active, 20% inactive
  color: isActive && isDarkColor(tabColor) ? "#fff" : undefined,
} : undefined;

return (
  <button style={colorStyle} className={cn(baseClasses, !colorStyle && defaultClasses)}>
    ...
  </button>
);
```

## Implementation Steps

1. Create `src/web/lib/color-utils.ts` with `isDarkColor()` utility
2. Modify `draggable-tab.tsx`:
   - Read `connectionColor` from tab metadata
   - Apply inline style for background color
   - Use `isDarkColor()` for text contrast
   - Active tab: full color; inactive: 20% opacity
3. Compile check + visual test

## Todo
- [x] Create color-utils.ts
- [x] Update DraggableTab with color styling
- [x] Compile check

## Completion Summary

**Delivered files:**
- `src/web/lib/color-utils.ts` — isDarkColor() with WCAG luminance calculation

**Updated files:**
- `src/web/components/layout/draggable-tab.tsx` — Color styling with automatic contrast

**Features:**
- Active tabs: full color background + auto-contrasted text
- Inactive tabs: 20% opacity color background
- WCAG 2.0 luminance-based contrast detection
- Graceful fallback for tabs without color

## Success Criteria
- ✓ Tabs with connection color show colored background
- ✓ Text automatically contrasts (white on dark, dark on light)
- ✓ Inactive colored tabs show muted/transparent version
- ✓ Tabs without color remain unchanged
