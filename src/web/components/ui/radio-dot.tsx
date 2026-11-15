/**
 * The dot a checked radio item shows in a menu. Not an icon: the product set's `circle` is a
 * ring (an outline with a hole), so `fill-current` on it still drew an empty circle.
 */
export function RadioDot() {
  return <span aria-hidden="true" className="block size-2 rounded-full bg-current" />;
}
