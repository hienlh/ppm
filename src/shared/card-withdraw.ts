/**
 * Withdrawing and replacing cards: a manager chat's (or the PPM Assistant's) way to take back a
 * card it sent that a newer card replaced, or that the user handled elsewhere. One switch in
 * Settings → Tools (`report_withdraw`) turns the whole of it on or off — the tool, the
 * `supersedes` and `task` fields of `report_to_assistant`, the Assistant's `card_withdraw`, the
 * reminders PPM adds to a manager's report, digest and task close, and dropping a closed task's
 * done and failed cards. It is a feature introduction, so it stays off until the user chooses.
 */
export const REPORT_WITHDRAW_TOOL = "report_withdraw";

/** The tool switches of card withdrawal (one, for the whole feature). */
export const CARD_TOOLS = [REPORT_WITHDRAW_TOOL] as const;

/** Most cards one call names. */
export const WITHDRAW_CARDS_MAX = 5;
