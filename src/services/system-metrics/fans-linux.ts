/**
 * Mission Center's Fan page, from `/sys/class/hwmon`. A chip exposes `fanN_input`
 * in RPM, an optional `pwmN` (0-255 duty) and often a `tempN_input` with the same
 * index — Mission Center pairs them by index, which is what the board's own
 * labelling means.
 *
 * Fans reading 0 are kept: a header with nothing plugged into it is information,
 * and hiding it would make the list change length as a fan spins down.
 */
import type { FanMetrics } from "../../types/system-metrics.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";

export const HWMON_DIR = "/sys/class/hwmon";
const PWM_MAX = 255;

export function collectLinuxFans(fs: Pick<LinuxFs, "list" | "read"> = realLinuxFs): FanMetrics[] {
  const fans: FanMetrics[] = [];
  for (const chip of (fs.list(HWMON_DIR) ?? []).sort()) {
    const dir = `${HWMON_DIR}/${chip}`;
    const name = readAttr(fs, `${dir}/name`) ?? chip;
    for (const index of fanIndices(fs, dir)) {
      const rpm = readNumber(fs, `${dir}/fan${index}_input`);
      if (rpm === undefined) continue;
      const pwm = readNumber(fs, `${dir}/pwm${index}`);
      const milliC = readNumber(fs, `${dir}/temp${index}_input`);
      fans.push({
        id: `${name}/fan${index}`,
        label: readAttr(fs, `${dir}/fan${index}_label`) ?? `Fan ${index}`,
        rpm: Math.max(0, Math.round(rpm)),
        ...(pwm === undefined ? {} : { pwmPercent: Math.round(pwm / PWM_MAX * 1000) / 10 }),
        ...(milliC === undefined ? {} : { tempC: Math.round(milliC / 100) / 10 }),
        ...defined("tempName", readAttr(fs, `${dir}/temp${index}_label`)),
      });
    }
  }
  return fans;
}

/** The `N` of every `fanN_input` the chip publishes, ascending. */
export function fanIndices(fs: Pick<LinuxFs, "list">, dir: string): number[] {
  const indices: number[] = [];
  for (const entry of fs.list(dir) ?? []) {
    const m = /^fan(\d+)_input$/.exec(entry);
    if (m) indices.push(Number(m[1]));
  }
  return indices.sort((a, b) => a - b);
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
