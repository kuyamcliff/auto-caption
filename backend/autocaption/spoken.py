"""Spoken-form expansion used only to help forced alignment.

wav2vec2 alignment models only know letters. A token such as "$25" is spoken as
"twenty five dollars" -- three words, roughly 0.8 s -- but aligning the literal
characters "$25" squeezes it into a few frames and drags the neighbouring words
with it. We align the spoken form and collapse it back onto the original token,
so the displayed text is unchanged while its timing covers the whole utterance.
"""
from __future__ import annotations

import re

try:
    from num2words import num2words
except ImportError:  # pragma: no cover - dependency is bundled
    num2words = None

NUM2WORDS_LANGS = {"en", "fr", "de", "es", "it", "pt", "nl", "ru", "pl", "cs", "da", "fi", "no",
                   "sv", "tr", "uk", "id", "hu", "ro", "vi", "he", "ar", "ko", "ja", "fa", "sl", "sk",
                   "lv", "kz", "te", "th"}

CURRENCY = {
    "en": {"$": "dollars", "€": "euros", "£": "pounds", "¥": "yen", "₹": "rupees", "₩": "won"},
    "es": {"$": "dólares", "€": "euros", "£": "libras"},
    "fr": {"$": "dollars", "€": "euros", "£": "livres"},
    "de": {"$": "dollar", "€": "euro", "£": "pfund"},
    "it": {"$": "dollari", "€": "euro", "£": "sterline"},
}
PERCENT = {"en": "percent", "es": "por ciento", "fr": "pour cent", "de": "prozent", "it": "per cento"}
AND = {"en": "and", "es": "y", "fr": "et", "de": "und", "it": "e"}

_EDGE_PUNCT = "\"'“”‘’.,!?;:()[]{}…—–-¡¿«»"
_ORDINAL = re.compile(r"^(\d+)(st|nd|rd|th)$", re.I)
_DECADE = re.compile(r"^(1[0-9]|20)(\d0)s$")
_TIME = re.compile(r"^(\d{1,2}):(\d{2})$")
_NUMBER = re.compile(r"^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$")


def _n2w(value, lang: str, **kw) -> str | None:
    if num2words is None:
        return None
    try:
        return num2words(value, lang=lang, **kw)
    except (NotImplementedError, OverflowError, ValueError, TypeError, KeyError, AttributeError):
        return None


def _number_words(raw: str, lang: str) -> str | None:
    clean = raw.replace(",", "")
    if "." in clean:
        return _n2w(float(clean), lang)
    n = int(clean)
    if lang == "en" and len(clean) == 4 and 1100 <= n <= 2099 and n % 1000 != 0 and "," not in raw:
        return _n2w(n, lang, to="year")
    return _n2w(n, lang)


def expand_token(token: str, lang: str) -> list[str]:
    """Return the spoken words for one written token (or [token] if unchanged)."""
    if lang not in NUM2WORDS_LANGS or not any(ch.isdigit() for ch in token) and token not in ("&", "%"):
        return [token]
    core = token.strip(_EDGE_PUNCT)
    if not core:
        return [token]
    if core == "&":
        return [AND.get(lang, "and")]
    prefix_words: list[str] = []
    suffix_words: list[str] = []
    cur = CURRENCY.get(lang, {})
    if core[0] in cur:
        suffix_words = cur[core[0]].split()
        core = core[1:]
    if core.endswith("%"):
        suffix_words = PERCENT.get(lang, "percent").split() + suffix_words
        core = core[:-1]
    spoken: str | None = None
    m = _ORDINAL.match(core)
    if m and lang == "en":
        spoken = _n2w(int(m.group(1)), lang, to="ordinal")
    elif _DECADE.match(core) and lang == "en":
        year = _n2w(int(core[:-1]), lang, to="year")
        if year:
            spoken = year[:-1] + "ies" if year.endswith("y") else year + "s"
    elif _TIME.match(core):
        h, mnt = _TIME.match(core).groups()
        hw, mw = _n2w(int(h), lang), _n2w(int(mnt), lang)
        if hw and mw:
            spoken = hw if int(mnt) == 0 else f"{hw} {mw}"
    elif _NUMBER.match(core):
        spoken = _number_words(core, lang)
    if spoken is None:
        return [token]
    words = prefix_words + re.sub(r"[-,]", " ", spoken).split() + suffix_words
    return words or [token]
