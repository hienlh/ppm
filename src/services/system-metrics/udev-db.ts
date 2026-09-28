/**
 * systemd-udevd's device database, `/run/udev/data/<device>`: one `E:KEY=VALUE`
 * line per property, world-readable. It already holds what `lspci`, `lsblk` and
 * `dmidecode` would be spawned for — adapter names from the PCI/USB hwdb, drive
 * models and serials, and DIMM facts from the SMBIOS table, whose raw file
 * (/sys/firmware/dmi/tables/DMI) is root-only. Reading it costs one small file
 * read and needs neither root nor a subprocess.
 *
 * Device file names: `+pci:<address>`, `b<major>:<minor>` for a block device,
 * `n<ifindex>` for a network interface, `+dmi:id` for the SMBIOS table.
 */
import type { FileReader } from "./linux-fs.ts";

export const UDEV_DATA_DIR = "/run/udev/data";

/** `E:` lines only; values are taken verbatim (udev already decoded `\x20`-style
 *  escapes into the plain keys, the `_ENC` variants keep them). */
export function parseUdevProperties(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("E:")) continue;
    const eq = line.indexOf("=", 2);
    if (eq < 0) continue;
    props.set(line.slice(2, eq), line.slice(eq + 1));
  }
  return props;
}

/** Properties of one device, or an empty map when udev has no record of it (no
 *  udevd in a container, a device that appeared before udev started). */
export function readUdevProperties(device: string, read: FileReader): Map<string, string> {
  const text = read(`${UDEV_DATA_DIR}/${device}`);
  return text ? parseUdevProperties(text) : new Map();
}

/** A non-empty trimmed value, or undefined — hwdb fields are sometimes padded. */
export function udevValue(props: ReadonlyMap<string, string>, key: string): string | undefined {
  const v = props.get(key)?.trim();
  return v ? v : undefined;
}
