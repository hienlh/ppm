/**
 * The PowerShell side of the AST helper: a loop that reads one request per line, parses the
 * script with PowerShell's own parser and writes the tree back as one JSON line. It never runs,
 * imports or evaluates the script — `Parser::ParseInput` and the AST nodes' property getters are
 * the only things it calls with the script's text.
 *
 * Framing: a request is `<id> <base64 of the script as UTF-16LE>`, so no script text can end a
 * line or forge another request; a reply is one line of pure-ASCII JSON (every other character
 * escaped as `\uXXXX`), so the console's code page cannot corrupt it.
 *
 * The tree is serialized generically by reflection rather than node type by node type: every
 * public property of every node is written (Ast children as nodes, collections as arrays,
 * `Tuple`s as two-element arrays, enums as names, numbers in the invariant culture), skipping
 * only `Parent`, `StaticType` and source extents. A node reached a second time (a
 * `ConvertExpressionAst` exposes its type as both `Type` and `Attribute`) is written as a
 * `{"$k":"ref"}` marker instead of twice. A node type the judge does not know therefore still
 * arrives whole, and the reply also carries `count` — the number of nodes `FindAll` sees — so the
 * TypeScript side can prove that no subtree was dropped on the way.
 *
 * The walk is one loop over an explicit stack of frames (a node's properties, or a list's items)
 * rather than a recursive function: a PowerShell function call costs ~0.1 ms, one per property
 * value made a 100-node script take ~100 ms to serialize.
 *
 * Kept to syntax Windows PowerShell 5.1 understands; sent with `-EncodedCommand`, so it needs
 * no quoting on a command line.
 */
export const POWERSHELL_AST_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$AstT = [System.Management.Automation.Language.Ast]
$ExtentT = [System.Management.Automation.Language.IScriptExtent]
$TypeNameT = [System.Management.Automation.Language.ITypeName]
$VarPathT = [System.Management.Automation.VariablePath]
$ListT = [System.Collections.IEnumerable]
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Flags = [System.Reflection.BindingFlags]'Public,Instance'
$Skip = @{ Parent = 1; StaticType = 1 }
$PropCache = @{}
$KeyCache = @{}
$Sb = New-Object System.Text.StringBuilder
$Seen = New-Object 'System.Collections.Generic.HashSet[object]'
$Frames = New-Object 'System.Collections.Generic.Stack[object]'
$NeedsEscape = New-Object System.Text.RegularExpressions.Regex '[^\x20-\x21\x23-\x5b\x5d-\x7e]'
$Escaper = [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int][char]$m.Value }
$VarFlags = 'IsDriveQualified', 'IsUnqualified', 'IsUnscopedVariable', 'IsVariable', 'IsGlobal', 'IsScript', 'IsLocal', 'IsPrivate'
$MaxDepth = 400

function Quote([string]$s) {
  if ($NeedsEscape.IsMatch($s)) { $s = $NeedsEscape.Replace($s, $Escaper) }
  return '"' + $s + '"'
}

function Serialize($root) {
  $Frames.Clear()
  $val = $root
  $has = $true
  while ($true) {
    if ($has) {
      $has = $false
      if ($null -eq $val) { [void]$Sb.Append('null') }
      elseif ($val -is $AstT) {
        if (-not $Seen.Add($val)) { [void]$Sb.Append('{"$k":"ref"}') }
        else {
          $t = $val.GetType()
          if (-not $PropCache.ContainsKey($t)) {
            $names = @{}
            $props = New-Object System.Collections.Generic.List[object]
            $keys = New-Object System.Collections.Generic.List[string]
            foreach ($p in $t.GetProperties($Flags)) {
              if ($Skip.ContainsKey($p.Name) -or $names.ContainsKey($p.Name)) { continue }
              if ($p.GetIndexParameters().Count -gt 0 -or $ExtentT.IsAssignableFrom($p.PropertyType)) { continue }
              $names[$p.Name] = 1
              $props.Add($p)
              $keys.Add(',"' + $p.Name + '":')
            }
            $PropCache[$t] = $props.ToArray()
            $KeyCache[$t] = $keys.ToArray()
          }
          if ($Frames.Count -ge $MaxDepth) { throw 'the script is nested too deeply' }
          [void]$Sb.Append('{"t":"').Append($t.Name).Append('"')
          $Frames.Push([object[]]@(0, $val, $PropCache[$t], $KeyCache[$t], 0))
        }
      }
      elseif ($val -is [string]) { [void]$Sb.Append((Quote $val)) }
      elseif ($val -is [bool]) { if ($val) { [void]$Sb.Append('true') } else { [void]$Sb.Append('false') } }
      elseif ($val -is [enum]) { [void]$Sb.Append((Quote $val.ToString())) }
      elseif ($val -is [ValueType]) { [void]$Sb.Append((Quote ([System.Convert]::ToString($val, $Inv)))) }
      elseif ($val -is $TypeNameT) { [void]$Sb.Append('{"$k":"type","FullName":').Append((Quote $val.FullName)).Append('}') }
      elseif ($val -is $VarPathT) {
        [void]$Sb.Append('{"$k":"var","UserPath":').Append((Quote $val.UserPath)).Append(',"DriveName":')
        if ($null -eq $val.DriveName) { [void]$Sb.Append('null') } else { [void]$Sb.Append((Quote $val.DriveName)) }
        foreach ($n in $VarFlags) { [void]$Sb.Append(',"').Append($n).Append('":'); if ($val.$n) { [void]$Sb.Append('true') } else { [void]$Sb.Append('false') } }
        [void]$Sb.Append('}')
      }
      else {
        $t = $val.GetType()
        if ($Frames.Count -ge $MaxDepth) { throw 'the script is nested too deeply' }
        if ($t.IsGenericType -and $t.Name -like 'Tuple*' -and $t.GetGenericArguments().Count -eq 2) {
          [void]$Sb.Append('[')
          $Frames.Push([object[]]@(1, $null, [object[]]@($val.Item1, $val.Item2), $null, 0))
        }
        elseif ($val -is $ListT) {
          [void]$Sb.Append('[')
          $items = New-Object System.Collections.Generic.List[object]
          foreach ($x in $val) { $items.Add($x) }
          $Frames.Push([object[]]@(1, $null, $items, $null, 0))
        }
        else { [void]$Sb.Append('{"$k":"other","type":').Append((Quote $t.FullName)).Append('}') }
      }
    }
    if ($Frames.Count -eq 0) { break }
    $f = $Frames.Peek()
    $i = $f[4]
    $items = $f[2]
    if ($i -lt $items.Count) {
      $f[4] = $i + 1
      if ($f[0] -eq 0) { [void]$Sb.Append($f[3][$i]); $val = $items[$i].GetValue($f[1], $null) }
      else { if ($i -gt 0) { [void]$Sb.Append(',') }; $val = $items[$i] }
      $has = $true
    }
    else {
      if ($f[0] -eq 0) { [void]$Sb.Append('}') } else { [void]$Sb.Append(']') }
      [void]$Frames.Pop()
    }
  }
}

$In = [Console]::In
$Out = [Console]::Out
$Out.WriteLine('{"ready":true,"ps":"' + $PSVersionTable.PSVersion.ToString() + '"}')
$Out.Flush()
while ($true) {
  $line = $In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  [void]$Sb.Clear()
  $Seen.Clear()
  $sp = $line.IndexOf(' ')
  $id = if ($sp -gt 0) { $line.Substring(0, $sp) } else { '' }
  if ($id -notmatch '^[0-9]{1,15}$') { $id = '0' }
  try {
    $code = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($line.Substring($sp + 1)))
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
      [void]$Sb.Append('{"id":"').Append($id).Append('","ok":false,"error":').Append((Quote ('parse error: ' + $errors[0].Message))).Append('}')
    } else {
      $count = @($ast.FindAll({ $true }, $true)).Count
      [void]$Sb.Append('{"id":"').Append($id).Append('","ok":true,"count":').Append($count).Append(',"ast":')
      Serialize $ast
      [void]$Sb.Append('}')
    }
  } catch {
    [void]$Sb.Clear()
    [void]$Sb.Append('{"id":"').Append($id).Append('","ok":false,"error":').Append((Quote ('helper error: ' + $_.Exception.Message))).Append('}')
  }
  $Out.WriteLine($Sb.ToString())
  $Out.Flush()
}
`;
