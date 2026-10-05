"""Where the Bible app's sources come from, and a cache for them.

Everything is fetched into $FACECLAW_BIBLE_CACHE (default
~/.cache/faceclaw-bible/sources), pinned to a commit where the source is a
git repository, so a rebuild sees the same data. The NET ePub is the one
exception: bible.org sits behind a browser check, so download it in a browser
from https://bible.org/downloads ("NET 2.1 Full Notes" ePub) and pass its
path, or drop it into the cache as NETBIBLE21.epub.
"""
import hashlib
import os
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

CACHE = Path(os.environ.get("FACECLAW_BIBLE_CACHE", Path.home() / ".cache" / "faceclaw-bible")) / "sources"

NET_EPUB = "NETBIBLE21.epub"
NET_EPUB_SHA256 = "e1b33a58499f1fe1cf2d95efbe56d0eb6072fd18cdf0bd9c4524b4c2caa18d9d"
NET_EPUB_URL = "https://bible.org/netbible/download/netbible/NETBIBLE21.epub"

STEP_COMMIT = "9776172b27065985f3f2cef81bba2ff416cd5f77"
STEP_FILES = {
    "TAHOT1": "Translators Amalgamated OT+NT/TAHOT Gen-Deu - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT2": "Translators Amalgamated OT+NT/TAHOT Jos-Est - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT3": "Translators Amalgamated OT+NT/TAHOT Job-Sng - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT4": "Translators Amalgamated OT+NT/TAHOT Isa-Mal - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAGNT1": "Translators Amalgamated OT+NT/TAGNT Mat-Jhn - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
    "TAGNT2": "Translators Amalgamated OT+NT/TAGNT Act-Rev - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
    "TBESH": "Lexicons/TBESH - Translators Brief lexicon of Extended Strongs for Hebrew - STEPBible.org CC BY.txt",
    "TBESG": "Lexicons/TBESG - Translators Brief lexicon of Extended Strongs for Greek - STEPBible.org CC BY.txt",
    "TEHMC": "Morphology codes/TEHMC - Translators Expansion of Hebrew Morphology Codes - STEPBible.org CC BY.txt",
    "TEGMC": "Morphology codes/TEGMC - Translators Expansion of Greek Morphhology Codes - STEPBible.org CC BY.txt",
    "TVTMS": "Versification/TVTMS - Translators Versification Traditions with Methodology for Standardisation for Eng+Heb+Lat+Grk+Others - STEPBible.org CC BY.txt",
}

OPENBIBLE_XREFS = "https://a.openbible.info/data/cross-references.zip"
BDB = ("https://github.com/eliranwong/unabridged-BDB-Hebrew-lexicon/raw/"
       "6e8326c6884f8ef1399c7a365d660da9bb9e2d01/unabridged-BDB-Hebrew-lexicon.csv.zip")
HEBREW_STRONG = ("https://raw.githubusercontent.com/openscriptures/HebrewLexicon/"
                 "21c9add13bc727d3a951361778e97e3ff7afd1ce/HebrewStrong.xml")
GREEK_STRONG = ("https://raw.githubusercontent.com/openscriptures/strongs/"
                "0acd2f251c2d35ff8db2dece4e0593979d3ac223/greek/StrongsGreekDictionaryXML_1.4/strongsgreek.xml")
THAYER = "https://github.com/imbennyhim/Every-Promise-Thayers/archive/a31ff38c40a681ef1029dcc51eb7e7ee3f2ea409.zip"


def _download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {url}", file=sys.stderr)
    request = urllib.request.Request(url, headers={"User-Agent": "faceclaw-bible-build"})
    with urllib.request.urlopen(request, timeout=120) as response, open(f"{target}.part", "wb") as out:
        shutil.copyfileobj(response, out)
    os.replace(f"{target}.part", target)


def fetch(url, name=None):
    """The cached copy of url (downloaded on first use)."""
    target = CACHE / (name or Path(urllib.parse.urlparse(url).path).name)
    if not target.exists():
        _download(url, target)
    return target


def step(key):
    rel = STEP_FILES[key]
    url = f"https://raw.githubusercontent.com/STEPBible/STEPBible-Data/{STEP_COMMIT}/{urllib.parse.quote(rel)}"
    return fetch(url, "step/" + Path(rel).name)


def unzip(path, member_suffix):
    """Extract the zip member ending with member_suffix next to the zip (once); its path."""
    with zipfile.ZipFile(path) as z:
        member = next(n for n in z.namelist() if n.endswith(member_suffix) and "__MACOSX" not in n)
        target = path.parent / (path.stem + ".d") / member
        if not target.exists():
            z.extract(member, path.parent / (path.stem + ".d"))
        return target


def net_epub(path=None):
    """The NET ePub, checked against the expected 2.1 edition."""
    candidate = Path(path) if path else CACHE / NET_EPUB
    if not candidate.exists():
        sys.exit(f"NET ePub not found at {candidate}.\nDownload \"NET 2.1 Full Notes\" (ePub) from "
                 f"https://bible.org/downloads in a browser, then pass --net-epub PATH or copy it to {CACHE / NET_EPUB}.")
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    if digest != NET_EPUB_SHA256:
        print(f"warning: {candidate} is not the NET 2.1 ePub this build was written against (sha256 {digest})", file=sys.stderr)
    return candidate
