"""
Builds src/shortcuts/catalog.json: Apple's built-in Shortcuts actions that the
assistant may use, from the ShortcutsBench dataset in "IOS SHORTCUTS DB".

    python scripts/build-shortcut-catalog.py

Only `is.workflow.actions.*` actions are kept. App-specific actions (Drafts,
Fantastical, com.apple.* App Intents, ...) use parameter encodings the
compiler doesn't handle, and only work if the app is installed.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT.parents[1] / "IOS SHORTCUTS DB" / "ShortcutsBench-master" / "data"
OUT = ROOT / "src" / "shortcuts" / "catalog.json"

PREFIX = "is.workflow.actions."

# Built as structured steps (if / repeat / menu / set / add_to / comment) instead.
STRUCTURED = {
    "conditional",
    "repeat.count",
    "repeat.each",
    "choosefrommenu",
    "setvariable",
    "appendvariable",
    "comment",
}

# Mac-only, scripting, payments, and retired third-party integrations.
EXCLUDED = {
    "runsshscript",
    "runapplescript",
    "runjavascriptforautomation",
    "runshellscript",
    "venmo.pay",
    "venmo.request",
    "facebook.messenger.send",
    "tweet",
    "imgur.upload",
    "giphy",
    "goodreader.open",
    "lightroom.import",
    "avairyeditphoto",
    "todoist.add",
    "deskconnect.send",
    "ejectdisk",
    "mountdiskimage",
    "makediskimage",
    "resizewindow",
    "showinblindsquare",
    "debug.contentattribution",
    "ride.requestride",
    "postonfacebook",
    "tumblr.post",
    "wordpress.post",
}
EXCLUDED_PREFIXES = (
    "trello.",
    "evernote.",
    "dropbox.",
    "pocket.",
    "instapaper.",
    "pinboard.",
    "properties.trello",
    "properties.evernote",
    "properties.dropbox",
)

# Parameters the dataset gets wrong or leaves out.
OVERRIDES = {
    "runworkflow": {
        "params": {
            "WFWorkflowName": {"type": "String", "doc": "Name of the shortcut to run, exactly as it appears in Shortcuts."},
            "WFInput": {"type": "WFVariablePickerParameter", "doc": "Input to pass to the shortcut."},
        },
    },
    "timer.start": {
        "params": {
            "WFDuration": {"type": "WFDurationQuantityFieldParameter", "doc": "How long the timer runs, e.g. {\"magnitude\": 5, \"unit\": \"min\"} (unit: sec, min, or hr)."},
        },
    },
    "openapp": {
        "params": {
            "WFAppIdentifier": {"type": "WFAppPickerParameter", "doc": "Bundle ID of the app, e.g. com.apple.mobilesafari."},
        },
    },
}

ENUM_RE = re.compile(r"must be one of the following values[^:]*:\s*(.*)")
ENUM_SENTENCE_RE = re.compile(
    r"\s*The value of this Enum must be one of the following values.*?:\s*"
    r"(?:\"[^\"]*\"(?:\s*\([^)]*\))?(?:,\s*)?)+\.?"
)


def clean_doc(doc: str):
    doc = ENUM_SENTENCE_RE.sub("", doc)
    return re.sub(r"\.{2,}", ".", doc).strip(" .")


def parse_params(info: str):
    """Parameter docs from the 'Parameters:' block, keyed by name."""
    docs = {}
    block = info.split("Parameters:\n", 1)
    if len(block) < 2:
        return docs
    for line in block[1].splitlines():
        if not line.startswith("    "):
            break
        m = re.match(r"\s+(\w+):\s*(.*)", line)
        if m:
            docs[m.group(1)] = m.group(2).strip()
    return docs


def parse_enum(doc: str):
    m = ENUM_RE.search(doc)
    if not m:
        return None
    return re.findall(r'"([^"]*)"', m.group(1).split(". This value depends")[0])


def section(info: str, name: str):
    m = re.search(rf"^{name}:\n((?:    .*\n?)+)", info, re.M)
    return m.group(1).strip() if m else ""


def main():
    infos = json.loads((DATA / "all_api2info.json").read_text(encoding="utf-8"))
    types = json.loads((DATA / "all_api2paraname2paratype.json").read_text(encoding="utf-8"))

    catalog = {}
    for full_id, info in sorted(infos.items()):
        if not full_id.startswith(PREFIX):
            continue
        short = full_id[len(PREFIX):]
        if short in STRUCTURED or short in EXCLUDED or short.startswith(EXCLUDED_PREFIXES):
            continue

        description = section(info, "Description")
        title, _, desc = description.partition(":")
        docs = parse_params(info)
        params = {}
        returns = None
        for pname, ptype in types.get(full_id, {}).items():
            if pname.startswith("ThisIsReturnValue:"):
                returns = pname.split(":", 1)[1]
                continue
            base, _, default = ptype.partition(" = ")
            base = base.replace("(Object)", "").strip()
            doc = docs.get(pname, "")
            entry = {"type": base, "doc": clean_doc(doc) or pname}
            enum = parse_enum(doc) if base == "Enum" else None
            if enum:
                entry["enum"] = enum
            if default:
                entry["default"] = default
            params[pname] = entry

        override = OVERRIDES.get(short, {})
        params.update(override.get("params", {}))

        # The dataset's ParameterSummary lines are often attached to the wrong action, so they're left out.
        entry = {"title": title.strip(), "desc": clean_doc(desc), "params": params}
        if returns:
            entry["returns"] = returns
        catalog[short] = entry

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(catalog)} actions -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
