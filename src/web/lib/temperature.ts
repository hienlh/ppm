/**
 * Temperature display unit — Mission Center's one Preferences setting that changes
 * what a number MEANS rather than how often it is fetched.
 *
 * Every collector reports Celsius, so this is purely a display conversion and the
 * conversion stays here rather than in six detail panels. `undefined` survives
 * untouched: the whole System Monitor treats it as "this host cannot measure
 * that", and a missing sensor must never render as 32 °F.
 */
export type TempUnit = "c" | "f";

export function toFahrenheit(celsius: number): number {
  return celsius * 9 / 5 + 32;
}

/** A temperature ready to render, or undefined when there is nothing to show. */
export function formatTemp(celsius: number | undefined, unit: TempUnit): string | undefined {
  if (celsius === undefined || !Number.isFinite(celsius)) return undefined;
  return unit === "f"
    ? `${toFahrenheit(celsius).toFixed(1)} °F`
    : `${celsius.toFixed(1)} °C`;
}

/** A value off localStorage is untrusted the same way one off the wire is. */
export function parseTempUnit(value: unknown): TempUnit {
  return value === "f" ? "f" : "c";
}
