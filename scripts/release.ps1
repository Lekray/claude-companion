<#
.SYNOPSIS
    Full release of the VS Code extension "claude-companion".

.DESCRIPTION
    One command from a clean working copy to a published GitHub release:
    version bump, syntax/JSON validation, .vsix build, local install into
    %USERPROFILE%\.vscode\extensions, VS Code extension cache sync, commit,
    tag, push, gh release.

    Close every VS Code window before running: Windows locks the files of the
    running extension and the local install step will fail while it is open.

.PARAMETER Version
    Release version, e.g. 1.2.0. Written to package.json, to the vsix manifest,
    to the folder name and to the git tag / GitHub release (v1.2.0).

.PARAMETER Notes
    Release notes. Defaults to "Release <Version>".

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 1.2.0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "Release $Version"
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$RepoName   = 'claude-companion'
$Publisher  = 'lekra'
$VsixPath   = Join-Path $env:USERPROFILE ".vscode\$RepoName-$Version.vsix"
$ExtRoot    = Join-Path $env:USERPROFILE '.vscode\extensions'
$ExtDir     = Join-Path $ExtRoot "$Publisher.$RepoName-$Version"
$ExtDirName = "$Publisher.$RepoName-$Version"
$CachePath  = Join-Path $ExtRoot 'extensions.json'

# Helper scripts are written to a temp folder instead of being passed as
# `node -e "..."` / `python -c "..."`: Windows PowerShell 5.1 swallows the
# double quotes inside such inline snippets when it hands them to a native exe.
$TempDir    = Join-Path ([System.IO.Path]::GetTempPath()) "claude-companion-release-$PID"

function Write-Log([string]$Message) {
    Write-Host "[release] $Message"
}

function Assert-LastExit([string]$What) {
    if ($LASTEXITCODE -ne 0) {
        throw "[release] $What failed with exit code $LASTEXITCODE"
    }
}

# --------------------------------------------------------------------------
# step 0 - environment
# --------------------------------------------------------------------------
Write-Log "repo    : $RepoRoot"
Write-Log "version : $Version"
Write-Log "vsix    : $VsixPath"

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z\.\-]+)?$') {
    throw "[release] version '$Version' is not a semver such as 1.2.0"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
    throw "[release] package.json not found - is $RepoRoot the repository root?"
}

foreach ($tool in @('node', 'python', 'git', 'gh')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "[release] required tool is not in PATH: $tool"
    }
}
Write-Log 'tools   : node, python, git, gh - ok'

Push-Location $RepoRoot
try {

    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

    # ----------------------------------------------------------------------
    # step 1 - clean working copy
    # ----------------------------------------------------------------------
    Write-Log 'step 1/8 checking that the working copy is clean'
    $dirty = @(git status --porcelain)
    Assert-LastExit 'git status --porcelain'
    if ($dirty.Count -gt 0) {
        $dirty | ForEach-Object { Write-Host "           $_" }
        throw '[release] working copy is not clean - commit, stash or discard the entries above first'
    }
    Write-Log '           clean'

    # ----------------------------------------------------------------------
    # step 2 - version bump in package.json (formatting preserved)
    # ----------------------------------------------------------------------
    Write-Log "step 2/8 setting version $Version in package.json"
    $bumpScript = Join-Path $TempDir 'bump-version.js'
    Set-Content -LiteralPath $bumpScript -Encoding ASCII -Value @'
const fs = require("fs");
const target = process.argv[2];
const version = process.argv[3];
const source = fs.readFileSync(target, "utf8");
const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/gm;
const found = source.match(pattern);
if (!found || found.length !== 1) {
    console.error("expected exactly one top-level version line, found " + (found ? found.length : 0));
    process.exit(1);
}
const updated = source.replace(pattern, "$1" + version + "$2");
JSON.parse(updated);
fs.writeFileSync(target, updated);
console.log("package.json version -> " + version);
'@
    node $bumpScript 'package.json' $Version
    Assert-LastExit 'package.json version bump'

    # ----------------------------------------------------------------------
    # step 3 - validation
    # ----------------------------------------------------------------------
    Write-Log 'step 3/8 validating sources'
    $jsFiles = @('extension.js', 'uninstall.js') +
               @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'src') -Filter '*.js' -File |
                 Sort-Object Name | ForEach-Object { "src/$($_.Name)" })
    foreach ($name in $jsFiles) {
        node --check $name
        Assert-LastExit "node --check $name"
        Write-Log "           $name syntax ok"
    }

    node --test 'test/**/*.test.js'
    Assert-LastExit 'unit tests (node --test)'
    Write-Log '           unit tests ok'

    $jsonFiles = @(Get-ChildItem -LiteralPath $RepoRoot -Filter '*.json' -File |
                   Sort-Object Name | ForEach-Object { $_.Name })
    if ($jsonFiles.Count -eq 0) {
        throw '[release] no *.json files found in the repository root'
    }
    $jsJson = Join-Path $TempDir 'validate-json.js'
    Set-Content -LiteralPath $jsJson -Encoding ASCII -Value @'
const fs = require("fs");
let bad = 0;
for (const file of process.argv.slice(2)) {
    try {
        JSON.parse(fs.readFileSync(file, "utf8"));
        console.log("           ok " + file);
    } catch (error) {
        console.error("           INVALID " + file + ": " + error.message);
        bad++;
    }
}
process.exit(bad ? 1 : 0);
'@
    node $jsJson @jsonFiles
    Assert-LastExit 'JSON validation'

    # ----------------------------------------------------------------------
    # step 4 - build the vsix
    # ----------------------------------------------------------------------
    Write-Log "step 4/8 building $VsixPath"
    python (Join-Path $PSScriptRoot 'build-vsix.py') '.' $Version $VsixPath
    Assert-LastExit 'build-vsix.py'
    if (-not (Test-Path -LiteralPath $VsixPath)) {
        throw "[release] the vsix was not created: $VsixPath"
    }

    # ----------------------------------------------------------------------
    # step 5 - local install (destructive: replaces the version folder, drops older ones)
    # ----------------------------------------------------------------------
    Write-Log "step 5/8 installing locally into $ExtDir"
    Write-Log '           the target folder is deleted and recreated, then filled from the working copy'
    if (Test-Path -LiteralPath $ExtDir) {
        try {
            Remove-Item -LiteralPath $ExtDir -Recurse -Force
        } catch {
            throw "[release] cannot remove $ExtDir ($($_.Exception.Message)) - close every VS Code window and retry"
        }
    }
    New-Item -ItemType Directory -Path $ExtDir -Force | Out-Null

    $payload = @('package.json', 'extension.js', 'uninstall.js', 'README.md', 'README.ru.md',
                 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE')
    $payload += @(Get-ChildItem -LiteralPath $RepoRoot -Filter 'package.nls*.json' -File |
                  Sort-Object Name | ForEach-Object { $_.Name })
    foreach ($name in $payload) {
        $source = Join-Path $RepoRoot $name
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $ExtDir -Force
            Write-Log "           + $name"
        } else {
            Write-Log "           ! $name missing - skipped"
        }
    }

    foreach ($folder in @('src', 'resources', 'docs')) {
        $source = Join-Path $RepoRoot $folder
        if (Test-Path -LiteralPath $source) {
            robocopy $source (Join-Path $ExtDir $folder) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
            # robocopy reports success with exit codes 0..7, everything >= 8 is a failure
            if ($LASTEXITCODE -ge 8) {
                throw "[release] robocopy $folder failed with exit code $LASTEXITCODE"
            }
            Write-Log "           + $folder\ (mirrored)"
        } else {
            Write-Log "           ! $folder missing - skipped"
        }
    }

    Write-Log "           deleting stale $Publisher.$RepoName-* folders except $ExtDirName"
    $stale = @(Get-ChildItem -LiteralPath $ExtRoot -Directory -Filter "$Publisher.$RepoName-*" -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -ne $ExtDirName })
    foreach ($dir in $stale) {
        Write-Log "           - $($dir.Name)"
        try {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force
        } catch {
            throw "[release] cannot remove $($dir.FullName) ($($_.Exception.Message)) - close every VS Code window and retry"
        }
    }

    # ----------------------------------------------------------------------
    # step 6 - VS Code extension cache (destructive: rewrites extensions.json)
    # ----------------------------------------------------------------------
    Write-Log "step 6/8 syncing the VS Code extension cache"
    Write-Log "           file  : $CachePath"
    Write-Log "           backup: $CachePath.bak"
    Write-Log "           set   : identifier.id == '$Publisher.$RepoName' -> version $Version, path $ExtDirName"

    # file:// URI form used by VS Code, e.g. /c:/Users/x/.vscode/extensions/<id>-<ver>
    $extUriPath = '/' + ($ExtDir -replace '\\', '/')
    if ($extUriPath -match '^/([A-Za-z]):(.*)$') {
        $extUriPath = '/' + $Matches[1].ToLower() + ':' + $Matches[2]
    }

    $cacheScript = Join-Path $TempDir 'sync-cache.py'
    Set-Content -LiteralPath $cacheScript -Encoding ASCII -Value @'
import json
import sys

cache, version, uri_path, relative = sys.argv[1:5]

with open(cache, "r", encoding="utf-8") as handle:
    text = handle.read()

data = json.loads(text)
if not isinstance(data, list):
    sys.exit("extensions.json is not a JSON array")

entry = None
for item in data:
    if isinstance(item, dict) and (item.get("identifier") or {}).get("id") == "lekra.claude-companion":
        entry = item
        break

if entry is None:
    print("[release] WARNING: no lekra.claude-companion record in extensions.json - cache sync skipped")
    sys.exit(0)

with open(cache + ".bak", "w", encoding="utf-8") as handle:
    handle.write(text)

entry["version"] = version
location = entry.setdefault("location", {"$mid": 1, "scheme": "file"})
location["path"] = uri_path
entry["relativeLocation"] = relative

with open(cache, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))

print("[release]           cached record: %s -> %s" % (relative, version))
'@
    python $cacheScript $CachePath $Version $extUriPath $ExtDirName
    Assert-LastExit 'extensions.json cache sync'

    # ----------------------------------------------------------------------
    # step 7 - commit, tag, push
    # ----------------------------------------------------------------------
    Write-Log 'step 7/8 committing, tagging and pushing'
    git add -A
    Assert-LastExit 'git add -A'
    $staged = @(git diff --cached --name-only)
    if ($staged.Count -gt 0) {
        $staged | ForEach-Object { Write-Log "           staged: $_" }
        git commit -m "Claude Code Companion $Version"
        Assert-LastExit 'git commit'
    } else {
        Write-Log '           nothing to commit'
    }

    git rev-parse -q --verify "refs/tags/v$Version" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $tagCommit = (git rev-list -n 1 "v$Version")
        $headCommit = (git rev-parse HEAD)
        if ($tagCommit -ne $headCommit) {
            throw "[release] tag v$Version already exists and points to another commit ($tagCommit)"
        }
        Write-Log "           tag v$Version already exists at HEAD - kept"
    } else {
        git tag "v$Version"
        Assert-LastExit "git tag v$Version"
        Write-Log "           tag v$Version created"
    }

    git push
    Assert-LastExit 'git push'
    git push origin "v$Version"
    Assert-LastExit 'git push origin tag'

    # ----------------------------------------------------------------------
    # step 8 - GitHub release
    # ----------------------------------------------------------------------
    Write-Log "step 8/8 creating the GitHub release v$Version"
    # gh prints "release not found" to stderr; redirecting a native command's
    # stderr makes PowerShell 5.1 raise a terminating NativeCommandError when
    # $ErrorActionPreference is 'Stop', so probe with 'Continue' instead.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    gh release view "v$Version" 2>$null | Out-Null
    $probeExit = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($probeExit -eq 0) {
        throw "[release] GitHub release v$Version already exists"
    }
    gh release create "v$Version" $VsixPath --title "Claude Code Companion $Version" --notes $Notes
    Assert-LastExit 'gh release create'

    Write-Log "done: v$Version -> $VsixPath"
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
