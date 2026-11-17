/**
 * The size an AI's words are read at in a chat: a message's text and the body of a PPM Assistant
 * card, which is a manager AI's report put in front of the user beside that chat. One class for
 * both, so a card never reads larger or smaller than the conversation around it.
 *
 * It has to be set on the card's text itself, not left to whatever wraps it: the decision set
 * draws a card outside the card frame, and its text then took the page's 16px root size, larger
 * than the card's own 15px title. Tailwind's `text-sm` also brings its own line height, so a
 * `leading-*` on a wrapper does not change how the lines are spaced.
 */
export const CHAT_MESSAGE_TEXT = "text-sm";
