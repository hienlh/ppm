/**
 * `ppm --profile dev <command …>`: which PPM database a command works on.
 *
 * Not a Commander option. A program-level `--profile` is read anywhere in argv, so it would take
 * `start --profile dev` (which names the profile the *server* runs on) as its own. Only the tokens
 * before the first subcommand are read here, they are spliced out, and the profile is set before
 * the command tree is built. `--instance <pid|id>` picks one server when several share a database.
 *
 * Without a flag, `PPM_PROFILE` decides; an empty value means the default `ppm.db`. PPM sets it
 * explicitly in every shell it starts, so a chat's commands reach the instance it runs on.
 */
export const PROFILE_ENV = "PPM_PROFILE";
export const INSTANCE_ENV = "PPM_INSTANCE_ID";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..");
}

export interface ProfileArgv {
  /** argv with the leading `--profile`/`--instance` tokens taken out. */
  argv: string[];
  /** The flag's value; undefined when no flag was given. */
  profile?: string;
  instance?: string;
}

const TAKES_VALUE = new Set(["--profile", "--instance"]);

/** Reads `--profile`/`--instance` from the tokens before the first subcommand. */
export function extractProfileArgv(argv: readonly string[]): ProfileArgv {
  const out: ProfileArgv = { argv: argv.slice(0, 2) };
  let i = 2;
  for (; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--" || !tok.startsWith("-")) break;
    const eq = tok.indexOf("=");
    const flag = eq > 0 ? tok.slice(0, eq) : tok;
    if (!TAKES_VALUE.has(flag)) { out.argv.push(tok); continue; }
    let value: string | undefined;
    if (eq > 0) value = tok.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value`);
      i++;
    }
    if (flag === "--profile") out.profile = value;
    else out.instance = value;
  }
  out.argv.push(...argv.slice(i));
  return out;
}

/**
 * The profile a command runs on: the flag, else `PPM_PROFILE`, else the default (null).
 * `"default"` names the default profile too, so a script can say so outright.
 */
export function resolveCliProfile(flag: string | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const raw = flag ?? env[PROFILE_ENV] ?? "";
  if (raw === "" || raw === "default") return null;
  if (!isValidProfileName(raw)) {
    throw new Error(`Invalid profile name "${raw}": letters, digits, ".", "_" and "-", up to 32 characters, starting with a letter or digit`);
  }
  return raw;
}

/** `start`/`autostart enable --profile x` against the profile already chosen for this command. */
export function commandProfile(own: string | undefined, chosen: string | null): string | null {
  if (own === undefined || own === "") return chosen;
  const named = resolveCliProfile(own, {});
  if (chosen !== null && named !== chosen) {
    throw new Error(`Two profiles were given: "${chosen}" (before the command or PPM_PROFILE) and "${own}" (--profile). Use one.`);
  }
  return named;
}
