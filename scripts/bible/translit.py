"""Transliterate pointed Hebrew and polytonic Greek into Latin letters, for
lexicon entries and notes that quote the originals in their own scripts (the
glasses show transliteration only). A simple academic style: ʾ ʿ for aleph and
ayin, ḥ ṭ ṣ š ś for the emphatics and sibilants, macrons for long vowels.
"""
import re
import unicodedata

_CONS = {
    "א": "ʾ", "ב": "v", "ג": "g", "ד": "d", "ה": "h", "ו": "w", "ז": "z", "ח": "ḥ", "ט": "ṭ",
    "י": "y", "כ": "kh", "ך": "kh", "ל": "l", "מ": "m", "ם": "m", "נ": "n", "ן": "n", "ס": "s",
    "ע": "ʿ", "פ": "f", "ף": "f", "צ": "ṣ", "ץ": "ṣ", "ק": "q", "ר": "r", "ש": "š", "ת": "t",
}
_HARD = {"ב": "b", "כ": "k", "ך": "k", "פ": "p", "ף": "p"}
_VOWELS = {
    "ְ": "ə", "ֱ": "e", "ֲ": "a", "ֳ": "o", "ִ": "i", "ֵ": "ē",
    "ֶ": "e", "ַ": "a", "ָ": "ā", "ֹ": "ō", "ֺ": "ō", "ֻ": "u", "ׇ": "o",
}
_DAGESH, _SHIN, _SIN, _HOLAM = "ּ", "ׁ", "ׂ", "ֹ"


def hebrew(text):
    """Transliterate a run of pointed Hebrew (cantillation is ignored)."""
    bare = "".join(c for c in text if "\u05d0" <= c <= "\u05ea")
    if bare == "יהוה":
        return "YHWH"
    out = []
    chars = [c for c in text if not ("֑" <= c <= "֯" or c in "ֽֿ׀׃ׅׄ‎‏")]
    i = 0
    while i < len(chars):
        c = chars[i]
        if c not in _CONS:
            if c == "־":  # maqqef
                out.append("-")
            elif c in _VOWELS:
                out.append(_VOWELS[c])
            elif not ("֐" <= c <= "׿"):
                out.append(c)
            i += 1
            continue
        marks = []
        j = i + 1
        while j < len(chars) and "ְ" <= chars[j] <= "ׇ":
            marks.append(chars[j])
            j += 1
        dagesh = _DAGESH in marks
        if c == "ו" and dagesh and not any(m in _VOWELS for m in marks):
            out.append("û")  # shureq
        elif c == "ו" and len(marks) == 1 and marks[0] in (_HOLAM, "\u05ba"):
            out.append("ô")  # holam male
        else:
            if c == "ש":
                out.append("ś" if _SIN in marks else "š")
            else:
                out.append(_HARD[c] if dagesh and c in _HARD else _CONS[c])
            for m in marks:
                if m in _VOWELS:
                    # Silent sheva at a word's end, and the furtive patah, stay simple.
                    out.append(_VOWELS[m])
        i = j
    word = "".join(out)
    word = re.sub(r"ə(?=\b|[-\s]|$)", "", word)
    word = word.replace("iy", "î").replace("ēy", "ê").replace("ey", "ê")
    return word


_GREEK = {
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "ē", "θ": "th", "ι": "i",
    "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s",
    "ς": "s", "τ": "t", "υ": "y", "φ": "ph", "χ": "ch", "ψ": "ps", "ω": "ō", "ϝ": "w",
}


def greek(text):
    """Transliterate polytonic Greek (rough breathing becomes h; other diacritics drop)."""
    out = []
    decomposed = unicodedata.normalize("NFD", text)
    words = re.split(r"(\s+)", decomposed)
    for word in words:
        letters = []
        rough = "̔" in word
        base = [c for c in word if not unicodedata.combining(c)]
        prev = ""
        for c in base:
            lower = c.lower()
            if lower in _GREEK:
                t = _GREEK[lower]
                # gamma before a velar is nasal; upsilon after a vowel is u.
                if lower == "γ" and prev == "γ":
                    letters[-1] = "n"
                if lower == "υ" and prev in "αεηοω":
                    t = "u"
                letters.append(t.capitalize() if c != lower else t)
                prev = lower
            else:
                letters.append(c)
                prev = ""
        result = "".join(letters)
        if rough and result:
            if result[0].isupper():
                result = "H" + result[0].lower() + result[1:]
            elif result[0] == "r":
                result = "rh" + result[1:]
            else:
                result = "h" + result
        out.append(result)
    return unicodedata.normalize("NFC", "".join(out))


_HEB_RUN = re.compile(r"[֐-׿‎‏]+(?:[\s־][֐-׿‎‏]+)*")
_GRK_RUN = re.compile(r"[Ͱ-Ͽἀ-῿][Ͱ-Ͽἀ-῿̀-ͯ]*(?:\s+[Ͱ-Ͽἀ-῿][Ͱ-Ͽἀ-῿̀-ͯ]*)*")


def latinize(text):
    """Replace every Hebrew and Greek run in prose with its transliteration, in italics-free plain text."""
    text = _HEB_RUN.sub(lambda m: hebrew(m.group(0)), text)
    return _GRK_RUN.sub(lambda m: greek(m.group(0)), text)
