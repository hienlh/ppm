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

/** The phone half of `TEXT_CONTROL_HEIGHT`. */
export const PHONE_TEXT_CONTROL_HEIGHT = "max-md:h-[26px]";

/** The phone size of a small icon button: 22px square below `md` (24px on desktop). */
export const PHONE_ICON_CONTROL_SIZE = "max-md:size-[22px]";
