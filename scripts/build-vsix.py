#!/usr/bin/env python3
"""Build a .vsix package for the claude-companion VS Code extension.

Usage:
    python scripts/build-vsix.py <repo_root> <version> <out_path>

Only the Python standard library is used, so no npm/node/vsce is required on
the build machine.  The produced archive is a plain zip with the usual OPC
layout:

    [Content_Types].xml
    extension.vsixmanifest
    extension/<extension files>
"""

import glob
import json
import os
import sys
import zipfile
from xml.sax.saxutils import escape

EXTENSION_ID = "claude-companion"
PUBLISHER = "lekra"
DISPLAY_NAME = "Claude Code Companion"
# Fallbacks only: the real values are read from package.nls.json / package.json so the
# manifest cannot drift from the extension (see read_manifest_fields).
DESCRIPTION = (
    "Companion extension for the official Claude Code VS Code extension: "
    "session statuses, sounds, subscription limits and DeepSeek spend."
)
ENGINE = "^1.100.0"
EXTENSION_KIND = "Workspace"
TAGS = "claude,claude-code,anthropic,ai,assistant"
CATEGORIES = "AI,Other"

# extension -> content type, in the order they are written to [Content_Types].xml
CONTENT_TYPES = [
    ("vsixmanifest", "text/xml"),
    ("json", "application/json"),
    ("js", "application/javascript"),
    ("md", "text/markdown"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("woff", "application/font-woff"),
    ("wav", "audio/wav"),
    ("txt", "text/plain"),
]

# Files that must be present for a usable package.
REQUIRED_FILES = ["package.json", "extension.js", "uninstall.js"]

# Files that are packaged when they exist (README.locale.md are optional).
OPTIONAL_FILES = [
    "README.md",
    "README.ru.md",
    "README.zh-CN.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
]

# Pure Node modules (src/) and bundled assets/documents.
SOURCE_DIRS = ["src"]
OPTIONAL_DIRS = ["resources", "docs"]


def log(message):
    print("[build-vsix] %s" % message)


def fail(message):
    sys.stderr.write("[build-vsix] ERROR: %s\n" % message)
    return 1


def collect_files(repo_root):
    """Return the package-relative paths to bundle, in a stable order.

    Required files are listed even when they are missing: main() then fails
    with a clear "missing files" message instead of producing a broken vsix.
    """
    files = list(REQUIRED_FILES)

    for name in SOURCE_DIRS:
        sources = sorted(
            os.path.basename(path)
            for path in glob.glob(os.path.join(repo_root, name, "*.js"))
        )
        if not sources:
            log("WARNING: %s/*.js not found" % name)
        files.extend("%s/%s" % (name, source) for source in sources)

    nls = sorted(
        os.path.basename(path)
        for path in glob.glob(os.path.join(repo_root, "package.nls*.json"))
    )
    if not nls:
        log("WARNING: no package.nls*.json found")
    files.extend(nls)

    for name in OPTIONAL_FILES:
        if os.path.isfile(os.path.join(repo_root, name)):
            files.append(name)
        else:
            log("WARNING: %s not found, skipped" % name)

    for name in OPTIONAL_DIRS:
        directory = os.path.join(repo_root, name)
        if not os.path.isdir(directory):
            log("WARNING: %s/ not found, skipped" % name)
            continue
        for current, dirnames, filenames in os.walk(directory):
            dirnames.sort()
            for filename in sorted(filenames):
                full = os.path.join(current, filename)
                files.append(os.path.relpath(full, repo_root).replace(os.sep, "/"))

    # Drop duplicates while keeping order (package.json may also match a mask).
    seen = set()
    unique = []
    for name in files:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return unique


def make_content_types(files):
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ]
    for extension, content_type in CONTENT_TYPES:
        lines.append(
            '  <Default Extension="%s" ContentType="%s"/>' % (extension, content_type)
        )
    # Files without an extension (LICENSE, NOTICE) need an explicit override.
    for name in files:
        if "." in os.path.basename(name):
            continue
        lines.append(
            '  <Override PartName="/extension/%s" ContentType="text/plain"/>'
            % escape(name)
        )
    lines.append("</Types>")
    return "\n".join(lines) + "\n"


def make_manifest(version, description, engine):
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<PackageManifest Version="2.0.0"'
        ' xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"'
        ' xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">\n'
        "  <Metadata>\n"
        '    <Identity Language="en-US" Id="%s" Version="%s" Publisher="%s" />\n'
        "    <DisplayName>%s</DisplayName>\n"
        '    <Description xml:space="preserve">%s</Description>\n'
        "    <Tags>%s</Tags>\n"
        "    <Categories>%s</Categories>\n"
        "    <GalleryFlags>Public</GalleryFlags>\n"
        "    <Properties>\n"
        '      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="%s" />\n'
        '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="%s" />\n'
        "    </Properties>\n"
        "  </Metadata>\n"
        "  <Installation>\n"
        '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />\n'
        "  </Installation>\n"
        "  <Dependencies />\n"
        "  <Assets>\n"
        '    <Asset Type="Microsoft.VisualStudio.Code.Manifest"'
        ' Path="extension/package.json" Addressable="true" />\n'
        "  </Assets>\n"
        "</PackageManifest>\n"
    ) % (
        escape(EXTENSION_ID),
        escape(version),
        escape(PUBLISHER),
        escape(DISPLAY_NAME),
        escape(description),
        escape(TAGS),
        escape(CATEGORIES),
        escape(engine),
        escape(EXTENSION_KIND),
    )


def read_manifest_fields(repo_root, package):
    """Return (description, engine) as the extension itself declares them."""
    description = DESCRIPTION
    nls_path = os.path.join(repo_root, "package.nls.json")
    if os.path.isfile(nls_path):
        with open(nls_path, "r", encoding="utf-8") as handle:
            description = json.load(handle).get("description") or description
    raw = package.get("description")
    if raw and not raw.startswith("%"):
        description = raw
    engine = (package.get("engines") or {}).get("vscode") or ENGINE
    return description, engine


def human_size(size):
    for unit in ("B", "KiB", "MiB"):
        if size < 1024 or unit == "MiB":
            return "%.1f %s" % (size, unit) if unit != "B" else "%d B" % size
        size /= 1024.0


def main(argv):
    if len(argv) != 4:
        sys.stderr.write(
            "usage: python scripts/build-vsix.py <repo_root> <version> <out_path>\n"
        )
        return 2

    repo_root = os.path.abspath(argv[1])
    version = argv[2].strip()
    out_path = os.path.abspath(argv[3])

    if not os.path.isdir(repo_root):
        return fail("repo root does not exist: %s" % repo_root)
    if not version:
        return fail("version is empty")

    package_json = os.path.join(repo_root, "package.json")
    if not os.path.isfile(package_json):
        return fail("package.json not found in %s" % repo_root)

    with open(package_json, "r", encoding="utf-8") as handle:
        package = json.load(handle)

    package_version = str(package.get("version", ""))
    if package_version != version:
        log(
            "WARNING: package.json version is %s but the manifest will say %s"
            % (package_version or "<missing>", version)
        )

    files = collect_files(repo_root)
    missing = [name for name in files if not os.path.isfile(os.path.join(repo_root, name))]
    if missing:
        return fail("missing files: %s" % ", ".join(missing))
    log("collected %d files" % len(files))

    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    if os.path.exists(out_path):
        os.remove(out_path)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", make_content_types(files))
        description, engine = read_manifest_fields(repo_root, package)
        archive.writestr(
            "extension.vsixmanifest", make_manifest(version, description, engine)
        )
        for name in files:
            archive.write(
                os.path.join(repo_root, name),
                "extension/" + name.replace(os.sep, "/"),
            )

    size = os.path.getsize(out_path)
    log("wrote %s (%s)" % (out_path, human_size(size)))
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
