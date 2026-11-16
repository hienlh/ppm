/**
 * PowerShell scripts and the verdict the read-only check must give each.
 *
 * The scripts are fixed text so their parsed trees can be recorded once on Windows
 * (`scripts/record-powershell-ast-fixtures.ts`) and judged anywhere. Paths into the throwaway
 * filesystem of `createCorpusFixture` are written as `C:\ppmfx\<name>` placeholders; a test
 * replaces them with the fixture's real folders — in the script text before a live parse, or in
 * every string of a recorded tree.
 *
 * Imports nothing at runtime, so the recording script can load it without touching PPM's state.
 */
import type { CorpusFixture } from "./adversarial-bash-corpus.ts";
import type { ReadonlyShellContext } from "../../../../src/services/assistant/readonly-shell/readonly-path-check.ts";

export interface PsCorpusCase {
  script: string;
  expected: "readonly" | "ask";
  why: string;
  /** Context overrides, on top of `powerShellCorpusContext`. */
  ctx?: (fx: CorpusFixture) => Partial<ReadonlyShellContext>;
}

const PLACEHOLDER = /C:\\ppmfx\\(proj2|proj|home|install|outside)/g;

/** Replaces every `C:\ppmfx\<name>` placeholder with the fixture's folder of that name. */
export function materialize(text: string, fx: CorpusFixture): string {
  const folders: Record<string, string> = { proj: fx.proj, proj2: fx.proj2, home: fx.home, install: fx.install, outside: fx.outside.replace(/[\\/]f\.txt$/, "") };
  return text.replace(PLACEHOLDER, (_m, name: string) => folders[name]!);
}

/**
 * Shell commands are judged with no working directory (the Assistant's own is inside PPM's
 * private folder) and with the user-profile variables pointing at the fixture's home.
 */
export function powerShellCorpusContext(fx: CorpusFixture): ReadonlyShellContext {
  return { ...fx.ctx, cwd: undefined, env: { USERPROFILE: fx.home, HOME: fx.home, TEMP: fx.base } };
}

const ro = (script: string, why: string, ctx?: PsCorpusCase["ctx"]): PsCorpusCase => ({ script, expected: "readonly", why, ctx });
const no = (script: string, why: string, ctx?: PsCorpusCase["ctx"]): PsCorpusCase => ({ script, expected: "ask", why, ctx });

/** Scripts the PPM Assistant ran in a real session, each approved by hand at the time. */
export const TRACE_SCRIPTS = [
  `$os = Get-CimInstance Win32_OperatingSystem; "Total GB: {0:N1}  Free GB: {1:N1}" -f ($os.TotalVisibleMemorySize/1MB), ($os.FreePhysicalMemory/1MB); "Uptime since: $($os.LastBootUpTime)"; Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id, @{n='MB';e={[int]($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200`,
  `Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 10 Name, Id, @{n='CommitMB';e={[int]($_.PrivateMemorySize64/1MB)}}, @{n='RAM_MB';e={[int]($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200; Get-CimInstance Win32_PageFileUsage | Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage | Format-Table -AutoSize | Out-String`,
  `$os = Get-CimInstance Win32_OperatingSystem; "RAM used: {0:N0}% ({1:N1} GB free of {2:N1})" -f (100 - $os.FreePhysicalMemory*100/$os.TotalVisibleMemorySize), ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB); Get-Process | Group-Object Name | ForEach-Object { [pscustomobject]@{Name=$_.Name; Count=$_.Count; MB=[int](($_.Group | Measure-Object WorkingSet64 -Sum).Sum/1MB)} } | Sort-Object MB -Descending | Select-Object -First 8 | Format-Table -AutoSize | Out-String`,
];

const withCwd = (fx: CorpusFixture) => ({ cwd: fx.proj });
const homeProject = (fx: CorpusFixture) => ({ projectRoots: [fx.home] });

export const POWERSHELL_CORPUS: readonly PsCorpusCase[] = [
  // Reads that run unasked.
  ...TRACE_SCRIPTS.map((script, i) => ro(script, `memory and process script ${i + 1} from a real session`)),
  ro(`Get-ChildItem C:\\ppmfx\\proj -Filter *.json | Select-Object Name, Length`, "listing a project with a filter"),
  ro(`Get-Content C:\\ppmfx\\proj\\a.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty version`, "a field of a project's JSON file"),
  ro(`Get-PSDrive -PSProvider FileSystem`, "file system drives"),
  ro(`git -C C:\\ppmfx\\proj status`, "a native read judged by the shared program specs"),
  ro(`Get-Process | Where-Object { $_.WorkingSet64 -gt 100MB } | Sort-Object CPU -Descending | Select-Object -First 5 Name, Id`, "a filtered process list"),
  ro(`Get-Content C:\\ppmfx\\proj\\log -Tail 50 2>$null`, "the end of a project file, errors discarded"),
  ro(`Get-Content C:\\ppmfx\\proj\\f -Encoding Byte | % { $_ }`, "bytes of a project file"),
  ro(`Select-String -Path C:\\ppmfx\\proj\\log -Pattern 'error' -SimpleMatch | Select-Object -First 20`, "searching a project file"),
  ro(`Get-ChildItem -LiteralPath C:\\ppmfx\\proj -Recurse -File | Measure-Object Length -Sum`, "size of a project, recursively"),
  ro(`$files = Get-ChildItem C:\\ppmfx\\proj\\src; $files.Count`, "a local variable read back"),
  ro(`try { Get-Item C:\\ppmfx\\proj\\a.json -ErrorAction Stop | Select-Object Length, LastWriteTime } catch { "missing" }`, "try/catch around a read"),
  ro(`foreach ($p in Get-Process) { if ($p.WorkingSet64 -gt 1GB) { "{0} {1:N0} MB" -f $p.Name, ($p.WorkingSet64/1MB) } }`, "foreach and if"),
  ro(`for ($i = 0; $i -lt 3; $i++) { [math]::Round($i * 1.5, 1) }`, "a for loop and [math]"),
  ro(`Get-Date -Format 'yyyy-MM-dd HH:mm'; [datetime]::Now.AddHours(-2).ToString('s')`, "dates"),
  ro(`Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004; StartTime=(Get-Date).AddDays(-1)} -MaxEvents 20 | Select-Object TimeCreated, Id, Message | Format-List`, "low-memory events from the System log"),
  ro(`Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, @{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}}`, "disk space"),
  ro(`Get-Counter '\\Memory\\Available MBytes' -SampleInterval 1 -MaxSamples 2`, "a performance counter"),
  ro(`Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object LocalAddress, OwningProcess`, "who listens on a port"),
  ro(`Get-Service | Where-Object Status -eq 'Running' | Measure-Object`, "Where-Object's simplified syntax"),
  ro(`Test-Path -LiteralPath C:\\ppmfx\\proj\\a.json`, "whether a project file exists"),
  ro(`Get-FileHash C:\\ppmfx\\proj\\a.json -Algorithm SHA256 | Format-List`, "a project file's hash"),
  ro(`Get-ChildItem`, "the folder the shell starts in, when PPM knows it", withCwd),
  ro(`Get-Content "$env:USERPROFILE\\notes\\todo.md"`, "a path through $env:USERPROFILE into a project", homeProject),
  ro(`Get-Content C:\\ppmfx\\install\\src\\index.ts -TotalCount 5`, "PPM's install folder is a read root"),
  ro(`rg -n TODO C:\\ppmfx\\proj\\src`, "ripgrep inside a project"),
  ro(`git -C C:\\ppmfx\\proj log --oneline -n 5 | Select-String fix`, "searching a program's text output"),
  ro(`$os = Get-CimInstance Win32_OperatingSystem; $os.Caption; $os.Version`, "properties of an allowed CIM class"),
  ro(`Get-Content C:\\ppmfx\\proj\\a.json -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 5`, "re-serializing data parsed from JSON"),
  ro(`@(Get-Process).Count; (Get-Process | Measure-Object WorkingSet64 -Sum).Sum / 1GB`, "counts and sums"),
  ro(`$ErrorActionPreference = 'SilentlyContinue'; Get-Process -Name nope`, "the error preference is writable"),
  ro(`Get-Volume C | Format-Table -AutoSize`, "a volume"),
  ro(`"Uptime: {0}" -f ((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime)`, "uptime arithmetic"),
  ro(`Get-ChildItem C:\\ppmfx\\proj -Recurse -Depth 2 -Directory | Select-Object FullName`, "folders of a project"),
  ro(`Get-Process | Group-Object Name -NoElement | Sort-Object Count -Descending | Select-Object -First 5`, "grouping"),
  ro(`Get-Content C:\\ppmfx\\proj\\log | Select-String -Pattern 'WARN|ERROR' | Select-Object -Last 10`, "searching lines read from a project file"),
  ro(`Get-Process | Format-Table Name, Id, @{Label='MB'; Expression={[int]($_.WS/1MB)}; Align='Right'} -AutoSize`, "a calculated column with prefixed keys"),
  ro(`Get-Content C:\\ppmfx\\proj\\a.json -Raw | ConvertFrom-Json | Where-Object { $_.name -like 'p*' }`, "filtering parsed JSON"),
  ro(`Get-Process -Name bun 2>&1 | Out-String`, "errors joined to the output"),

  // Everything below asks.
  no(`iex 'Get-Process'`, "Invoke-Expression runs text"),
  no(`& { Remove-Item x }`, "the call operator"),
  no(`. .\\x.ps1`, "dot-sourcing a script"),
  no(`Get-Process | % { $_.Kill() }`, "a method that kills"),
  no(`Get-Content $env:USERPROFILE\\.ssh\\id_rsa`, "an SSH key through $env:USERPROFILE"),
  no(`gc ~\\.aws\\credentials`, "AWS credentials through ~"),
  no(`Get-ChildItem Env:`, "the environment drive"),
  no(`$env:ANTHROPIC_API_KEY`, "an environment variable that may hold a secret"),
  no(`"$env:CLAUDE_CODE_OAUTH_TOKEN"`, "a secret expanded in a string"),
  no(`Get-Content C:\\ppmfx\\proj\\f -Stream x`, "an alternate data stream parameter"),
  no(`Get-Content C:\\ppmfx\\proj\\f -Wait`, "a read that never ends"),
  no(`Get-Content C:\\ppmfx\\proj\\*`, "a wildcard path"),
  no(`gci C:\\ -Recurse`, "walking a whole drive"),
  no(`gci $HOME -Recurse`, "$HOME is not a variable the script set"),
  no(`[IO.File]::WriteAllText('C:\\ppmfx\\proj\\f','x')`, "a .NET type that writes"),
  no(`[scriptblock]::Create('rm x').Invoke()`, "a script block built from text"),
  no(`(New-Object Net.WebClient).DownloadString('http://x')`, "New-Object and the network"),
  no(`Get-Process | Out-File C:\\ppmfx\\proj\\x`, "Out-File writes"),
  no(`Get-Process > C:\\ppmfx\\proj\\x`, "a file redirection"),
  no(`Get-Process | Set-Content x`, "Set-Content writes"),
  no(`Get-CimInstance Win32_Process | Select CommandLine`, "process command lines"),
  no(`(Get-Process -Id 1).StartInfo.EnvironmentVariables`, "StartInfo copies the shell's own environment"),
  no(`Get-WmiObject -Class $c`, "a CIM class from a variable"),
  no(`Start-Process notepad`, "starting a process"),
  no(`$x='Remove-Item'; & $x f`, "a command named by a variable"),
  no(`Get-Item HKLM:\\SOFTWARE\\x`, "the registry"),
  no(`gci \\\\server\\share`, "a network share"),
  no(`gc C:\\ppmfx\\proj\\f.txt:ads`, "an NTFS stream"),
  no(`gc C:\\Users\\PC\\PPM~1\\ppm.db`, "an 8.3 short name"),
  no(`git -C C:\\ppmfx\\proj -c core.pager=x log`, "git configuration from the command line"),
  no(`sqlite3 "C:\\Users\\PC\\.ppm\\ppm.db" "select 1"`, "PPM's database"),
  no(`Get-Process; Remove-Item x`, "a write after a read"),
  no(`Get-Process && rm x`, "a chain into a delete"),
  no(`Get-Process | {`, "a parse error"),
  no(`function Get-Process { rm x }; Get-Process`, "a function shadowing a cmdlet"),
  no(`Set-Alias gc Remove-Item; gc x`, "an alias shadowing a cmdlet"),
  no(`$ExecutionContext.InvokeCommand.InvokeScript('rm x')`, "the engine's own invoke"),
  no(`Get-Content -Path ('C:\\'+'.ssh')`, "a path computed by an expression"),
  no(`Get-Content C:\\ppmfx\\proj\\f -ReadCount 0 | iex`, "file text handed to Invoke-Expression"),
  no(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, @{n='Cmd';e={$_.CommandLine}}`, "a command line through a calculated property"),
  no(`Select-String -Path "$env:USERPROFILE\\.ppm\\ppm.log" -Pattern 'x'`, "PPM's own log folder"),
  no(`$db = "$env:USERPROFILE\\.ppm\\ppm.db"; sqlite3 $db "select 1"`, "a program given a variable"),
  no(`Get-Process | Select-Object *`, "every property, secret-bearing ones included"),
  no(`Get-Process | Format-List *`, "every property, formatted"),
  no(`Get-Process | ConvertTo-Json -Depth 4`, "serializing live process objects"),
  no(`Get-Process | Select-Object Name | ConvertTo-Json`, "serializing objects not parsed from JSON"),
  no(`Get-ChildItem C:\\ppmfx\\proj | Get-Content`, "a path handed through the pipeline"),
  no(`'C:\\ppmfx\\home\\.ssh\\id_rsa' | Get-Content`, "a key path handed through the pipeline"),
  no(`Get-ChildItem C:\\ppmfx\\proj | Select-String secret`, "Select-String reading files it is handed"),
  no(`Get-Process | % Kill`, "ForEach-Object calling a method by name"),
  no(`Get-Process | ForEach-Object -MemberName Kill`, "ForEach-Object -MemberName"),
  no(`$p = Get-Process -Id 1; $p.PriorityClass = 'Idle'`, "assigning to a live object's property"),
  no(`$PSDefaultParameterValues = @{}`, "changing default parameters"),
  no(`$global:x = 1`, "a global variable"),
  no(`$p = @{}; Get-Process @p`, "splatting"),
  no(`Get-Process -ComputerName srv`, "a parameter not on the list"),
  no(`Get-Process -Module`, "Get-Process -Module"),
  no(`Get-Content -Pa C:\\ppmfx\\proj\\f`, "a parameter prefix"),
  no(`Get-Content C:\\ppmfx\\proj\\link-to-ssh\\id_rsa`, "a junction into the SSH folder"),
  no(`gc C:\\ppmfx\\proj\\..\\home\\.ssh\\id_rsa`, "climbing out of a project"),
  no(`Get-WinEvent -FilterHashtable @{LogName='Security'}`, "the Security log"),
  no(`Get-WinEvent -LogName System`, "Get-WinEvent without a filter hashtable"),
  no(`Get-WinEvent -FilterHashtable @{LogName='System'} -MaxEvents 50`, "every event of the System log, service installs included"),
  no(`Get-WinEvent -FilterHashtable @{LogName='System'; Id=7045}`, "service installs, whose message holds the command line"),
  no(`Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004, 7045}`, "a list of ids that includes service installs"),
  no(`Get-WinEvent -FilterHashtable @{LogName='Application'; Id=4697}`, "the Security service-install id"),
  no(`Get-WinEvent -FilterHashtable @{LogName='System'; Id=$id}`, "an event id from a variable"),
  no(`Get-WinEvent -FilterHashtable @{LogName='System'; Id=(7000+45)}`, "an event id computed by an expression"),
  ro(`Get-WinEvent -FilterHashtable @{LogName='System','Application'; Id=41, 1001, 6008} -MaxEvents 10 | Format-List TimeCreated, Id, Message`, "crash and shutdown events by id"),
  no(`Get-PSDrive`, "every PowerShell drive"),
  no(`Get-ChildItem Variable:`, "the variable drive"),
  no(`Get-Content Microsoft.PowerShell.Core\\FileSystem::C:\\ppmfx\\proj\\f`, "a provider-qualified path"),
  no(`[Environment]::GetEnvironmentVariable('X')`, "[Environment]"),
  no(`$x = $env:PATH`, "an environment variable not on the list"),
  no(`"a" -replace 'a', { rm x }`, "a script block as a replacement"),
  no(`$s = { rm x }`, "a script block kept in a variable"),
  no(`Get-Process | Where-Object { $_.Kill() }`, "a method that kills inside a filter"),
  no(`Get-Process | Select-Object @{n='e';e={Remove-Item x}}`, "a delete inside a calculated property"),
  no(`while ($true) { Get-Date }`, "an unbounded loop"),
  no(`Invoke-WebRequest http://x`, "the network"),
  no(`curl http://x`, "the network through an alias"),
  no(`Write-Output hi`, "Write-* is not on the list"),
  no(`Get-Content C:\\ppmfx\\proj\\f 3>&1`, "a stream merge other than 2>&1"),
  no(`Get-Content C:\\ppmfx\\proj\\f 2> C:\\ppmfx\\proj\\err`, "errors written to a file"),
  no(`git -C C:\\ppmfx\\proj log -n:5`, "a native argument PowerShell splits in two"),
  no(`git -C C:\\ppmfx\\proj log -- src`, "-- which some PowerShell versions drop"),
  no(`git -C $env:USERPROFILE status`, "a native argument from a variable"),
  no(`Get-Content C:\\ppmfx\\proj\\f | sqlite3 C:\\ppmfx\\proj\\data.db`, "text piped into a program that runs it"),
  no(`Get-ChildItem -Path C:\\ppmfx\\proj -FollowSymlink -Recurse`, "following links while walking"),
  no(`[pscustomobject]@{a = (Get-Process -Id 1).StartInfo}`, "StartInfo inside an object"),
  no(`$x = Get-Process -Id 1; $x.psobject.Properties`, "reflection through psobject"),
  no(`Get-Process | Sort-Object { $_.StartInfo.EnvironmentVariables.Count }`, "StartInfo inside a sort key"),
  no(`Get-Content -LiteralPath "$env:SECRET_DIR\\f"`, "a path through an unlisted variable"),
  no(`Get-Content -Path "C:\\ppmfx\\proj\\$(rm x)"`, "a subexpression inside a path"),
  no(`Get-Content C:\\ppmfx\\outside\\f.txt`, "a file outside every project"),
  no(`Get-ChildItem`, "the working folder, which PPM was not told"),
  no(`Get-Command -Module x`, "loading a module's commands"),
  no(`Get-Command git -CommandType Application | Select-Object Source`, "a command lookup can auto-load a module, which runs its code"),
  no(`Test-Path C:\\ppmfx\\proj -Filter ..\\home\\.ssh\\id_rsa`, "a filter that climbs out of the folder"),
  no(`Get-ChildItem C:\\ppmfx\\proj link-to-ssh\\*`, "a positional filter naming a subfolder"),
  no(`(Get-Item C:\\ppmfx\\proj\\a.json).Replace('C:\\ppmfx\\proj\\f', $null)`, "FileInfo.Replace overwrites a file"),
  no(`Get-Counter '\\\\server\\Memory\\Available MBytes'`, "a counter on another computer"),
  no(`\${C:\\ppmfx\\home\\.ssh\\id_rsa}`, "a file read through variable syntax"),
  no(`sqlite3 -readonly C:\\ppmfx\\home\\.ppm\\ppm.db "select 1"`, "PPM's database, even read-only", homeProject),
  no(`Select-String -Path "$env:USERPROFILE\\.ppm\\ppm.log" -Pattern 'x'`, "PPM's folder stays private in a home-folder project", homeProject),
  no(`Get-Content $env:USERPROFILE\\.ssh\\id_rsa`, "an SSH key in a home-folder project", homeProject),
  no(`$files = Get-ChildItem C:\\ppmfx\\proj; $files | Select-String x`, "Select-String over objects of unknown kind"),
  no(`Get-ChildItem C:\\ppmfx\\proj -Recurse | Get-FileHash`, "hashing files handed through the pipeline"),
  no(`Get-Process | Select-Object -ExpandProperty StartInfo`, "expanding StartInfo"),
  no(`Get-Process | Format-Table -Property *`, "every property as a table"),
  no(`Get-Process | Where-Object CommandLine -like '*token*'`, "filtering on a command line"),
  no(`Get-Process | Sort-Object @{Expression={$_.Kill()}}`, "a method call inside a sort expression"),
  no(`Get-Process | Select-Object @{n='x';ex='CommandLine'}`, "a command line through a prefixed expression key"),
  no(`$ErrorActionPreference = 'Stop'; Get-Content C:\\ppmfx\\proj\\f -OutVariable o`, "-OutVariable"),
  no(`[datetime]::Now | ForEach-Object { $_.ToString() } -Begin { Remove-Item x }`, "a write in a -Begin block"),
  no(`Get-Process | ConvertFrom-Json | ConvertTo-Json`, "ConvertFrom-Json does not make live objects safe"),
  no(`Get-Service cloudflared | Select-Object Name, BinaryPathName`, "a service's command line"),
  ro(`Get-Process | Select-Object Name, Path, @{n='Modules';e={$_.Modules.Count}}`, "Path and Modules stay readable"),
  ro(`Get-ChildItem -LiteralPath C:\\ppmfx\\proj -Include *.json, *.ts -Name`, "include patterns"),
  ro(`$n = 0; Get-Content C:\\ppmfx\\proj\\log | ForEach-Object { $n++ }; $n`, "a counter in a local variable"),
];
