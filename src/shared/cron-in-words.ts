/**
 * A 5-field cron in words, without React or a cron library: shared by the browser's schedule views
 * and the server's notice about a schedule an AI created, so both describe one schedule alike.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INT = /^\d+$/;

const pad = (n: string) => n.padStart(2, "0");

/** "1-5" or "1,3,5" as weekday names; null when the field is not a plain list or range of days. */
function weekdayText(field: string): string | null {
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0") return "weekends";
  const days: string[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to || to > 7) return null;
      days.push(`${WEEKDAYS[from % 7]}–${WEEKDAYS[to % 7]}`);
    } else if (/^\d$/.test(part) && Number(part) <= 7) {
      days.push(WEEKDAYS[Number(part) % 7]!);
    } else return null;
  }
  return days.join(", ");
}

/**
 * A 5-field cron in words for the common shapes ("Daily at 08:00", "Every 15 minutes"); the
 * expression itself for anything else, which is never wrong, only less friendly.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min === "*") return "Every minute";
    const every = /^\*\/(\d+)$/.exec(min);
    if (every) return `Every ${every[1]} minutes`;
    if (INT.test(min)) return `Hourly at :${pad(min)}`;
    return expr;
  }
  if (!INT.test(min) || !INT.test(hour)) return expr;
  const at = `${pad(hour)}:${pad(min)}`;
  if (dom === "*" && mon === "*") {
    if (dow === "*") return `Daily at ${at}`;
    const days = weekdayText(dow);
    return days ? `${days[0]!.toUpperCase()}${days.slice(1)} at ${at}` : expr;
  }
  if (dow !== "*" || !INT.test(dom)) return expr;
  if (mon === "*") return `Monthly on day ${dom} at ${at}`;
  if (INT.test(mon) && Number(mon) >= 1 && Number(mon) <= 12) return `${MONTHS[Number(mon) - 1]} ${dom} at ${at}`;
  return expr;
}
