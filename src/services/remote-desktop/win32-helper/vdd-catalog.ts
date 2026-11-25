/**
 * The one virtual display driver PPM installs, pinned by version and by hash.
 *
 * VirtualDrivers/Virtual-Display-Driver (MIT): an IddCx indirect display driver, i.e. UMDF —
 * it runs in user mode, not in the kernel. The release asset named `-x86` is the x64 build
 * (its INF targets `NTamd64`). Checked on 25/11/2026 by downloading and reading it, never by
 * installing: the zip's SHA-256 matches GitHub's published digest, and the catalog and the DLL
 * both carry a Valid Authenticode signature from SignPath Foundation (issuer GlobalSign GCC R45
 * CodeSigning CA 2020).
 *
 * Two things read out of the driver binary shape how PPM uses it:
 * - it opens `\\.\pipe\MTTVirtualDisplayPipe` with SDDL `D:(A;;GA;;;WD)` — Everyone may send it
 *   commands — so the device is kept disabled except while a Remote Desktop session needs it;
 * - it reads `vdd_settings.xml` from the folder in `HKLM\SOFTWARE\MikeTheTech\VirtualDisplayDriver`
 *   `VDDPATH`, else `C:\VirtualDisplayDriver`, which any user can create. PPM points `VDDPATH`
 *   into its own Program Files folder.
 *
 * Updating the driver is a deliberate edit of every value here, never a "latest" lookup.
 */
export const VDD_VERSION = "25.7.23";
export const VDD_ZIP_URL =
  "https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip";
export const VDD_ZIP_SHA256 = "e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a";
export const VDD_ZIP_NAME = `vdd-${VDD_VERSION}.zip`;

/** The folder inside the zip, and every file in it with its SHA-256. */
export const VDD_ZIP_FOLDER = "VirtualDisplayDriver";
export const VDD_FILES: Readonly<Record<string, string>> = {
  "MttVDD.dll": "c9ca837f57a98fbd43bc416a7f535a95843626e7759eaf85cf0cd7ce334dbb05",
  "MttVDD.inf": "550d211fe481e74dfe3f9d724ed78be48b3a9113405965d683d9373e8d672f5d",
  "mttvdd.cat": "08a0093fc9b2e32b287a6f8a77ca4de0a31830d29fc33d2b13a918dc859468f6",
  "vdd_settings.xml": "edb2501d6d5da17f66d15d4b97a6f4a3f0d8963165ac4a6a6259d95118288020",
};

/** Files whose Authenticode signature is checked, and the exact signer they must carry. A
 *  Valid signature alone proves only that *someone* with a code-signing certificate signed it. */
export const VDD_SIGNED_FILES = ["mttvdd.cat", "MttVDD.dll"] as const;
export const VDD_SIGNER_SUBJECT = "CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US";

export const VDD_INF = "MttVDD.inf";
export const VDD_HARDWARE_ID = "Root\\MttVDD";
export const VDD_SETTINGS_KEY = "HKLM:\\SOFTWARE\\MikeTheTech\\VirtualDisplayDriver";
/** `GUID_DEVCLASS_DISPLAY`. */
export const DISPLAY_CLASS_GUID = "{4D36E968-E325-11CE-BFC1-08002BE10318}";
/** The release's own `vdd_settings.xml` (hash-pinned above) is used as it is: one monitor, the
 *  usual resolutions from 800x600 to 8K. The user picks the size in Windows' Display settings. */
