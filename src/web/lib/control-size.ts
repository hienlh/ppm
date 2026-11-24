/**
 * The sizes every button, chip and toolbar button takes (docs/design-guidelines.md, rule 3): the
 * drawn sizes of the chip row above the chat composer, whose own classes are `FOOTER_CHIP` and
 * `FOOTER_GHOST` in `components/chat/footer-chip.ts`. There is no 44px minimum.
 *
 * The `PHONE_` halves are for a control whose desktop size is set by something else (a Button
 * variant, an `md:` class beside it) and only its phone size follows the standard.
 */

/** A chip or a button with text: 28px tall, 26px below `md`. */
export const TEXT_CONTROL_HEIGHT = "h-7 max-md:h-[26px]";

/**
 * The rest of a button with text, laid over a `Button` variant (which keeps its colours): 10px side
 * padding (5px below `md`), 11.5px text, 14px icon, fully rounded, as `FOOTER_CHIP` draws it. The
 * `has-[>svg]` padding and `py-0` override what `Button`'s default size adds; give icons inside it
 * `size-3.5`, since `Button` sizes an icon without a size class to 16px.
 */
export const TEXT_BUTTON =
  `${TEXT_CONTROL_HEIGHT} gap-1.5 rounded-full py-0 px-2.5 text-[11.5px] has-[>svg]:px-2.5 ` +
  "max-md:px-[5px] max-md:has-[>svg]:px-[5px]";

/** The phone half of `TEXT_CONTROL_HEIGHT`. */
export const PHONE_TEXT_CONTROL_HEIGHT = "max-md:h-[26px]";

/** The phone size of a small icon button: 22px square below `md` (24px on desktop). */
export const PHONE_ICON_CONTROL_SIZE = "max-md:size-[22px]";
