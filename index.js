// Hover Edit - SillyTavern extension
// Hover over text in a message, press a hotkey, and jump straight into edit mode
// with the caret placed exactly where your mouse was.
// https://github.com/serioos/Hover-Edit

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'hover_edit';
const LOG = '[Hover Edit]';

const HOTKEY_EDIT_DEFAULT = { code: 'KeyE', ctrl: false, alt: true, shift: false, meta: false };
// SillyTavern already saves an edit on Ctrl/Cmd + Enter by itself.
const HOTKEY_SAVE_DEFAULT = { code: 'Enter', ctrl: true, alt: false, shift: false, meta: false };

const defaultSettings = {
    enabled: true,
    alignCaret: true,   // scroll the chat so the caret ends up under the mouse
    scrollOnDone: true, // after an edit is saved or canceled, scroll to where the caret was
    highlight: true,    // highlight the word at the caret (entering, saving, canceling)
    hotkey: { ...HOTKEY_EDIT_DEFAULT },
    saveHotkey: { ...HOTKEY_SAVE_DEFAULT },
};

let lastX = 0;
let lastY = 0;
let capturing = null; // null | 'edit' | 'save': waiting for the user to press a new hotkey
let busy = false;     // guards against double triggers while entering edit mode

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// rAF is paused in background tabs, so never rely on it alone
const nextFrame = () => new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 50);
});

// Resolves with check()'s first truthy result, as soon as the DOM under `root` makes it
// true (no polling), or null after `timeout` ms.
function waitFor(root, check, timeout) {
    return new Promise((resolve) => {
        let v = check();
        if (v) { resolve(v); return; }
        const obs = new MutationObserver(() => {
            v = check();
            if (v) finish(v);
        });
        const timer = setTimeout(() => finish(null), timeout);
        function finish(val) {
            obs.disconnect();
            clearTimeout(timer);
            resolve(val);
        }
        obs.observe(root, { childList: true, subtree: true });
    });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function loadSettings() {
    const s = Object.assign({}, defaultSettings, extension_settings[MODULE]);
    s.hotkey = Object.assign({}, defaultSettings.hotkey, s.hotkey);
    s.saveHotkey = Object.assign({}, defaultSettings.saveHotkey, s.saveHotkey);
    extension_settings[MODULE] = s;
}

function cfg() {
    return extension_settings[MODULE];
}

const KEY_LABELS = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: '\'', Comma: ',', Period: '.', Slash: '/',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

function keyLabel(code) {
    if (KEY_LABELS[code]) return KEY_LABELS[code];
    return code.replace(/^Key/, '').replace(/^Digit/, '');
}

function hotkeyLabel(hk) {
    const parts = [];
    if (hk.ctrl) parts.push('Ctrl');
    if (hk.alt) parts.push('Alt');
    if (hk.shift) parts.push('Shift');
    if (hk.meta) parts.push('Meta');
    parts.push(keyLabel(hk.code));
    return parts.join(' + ');
}

function hotkeyMatches(e, hk) {
    return e.code === hk.code
        && e.ctrlKey === hk.ctrl
        && e.altKey === hk.alt
        && e.shiftKey === hk.shift
        && e.metaKey === hk.meta;
}

// True when the save hotkey is SillyTavern's own Ctrl + Enter. In that case SillyTavern does
// the saving and Hover Edit only watches it (to scroll / highlight afterwards).
function isNativeSave(hk) {
    return hk.code === 'Enter' && hk.ctrl && !hk.alt && !hk.shift && !hk.meta;
}

const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];

/* ------------------------------------------------------------------ */
/* Text mapping: rendered text -> raw markdown text                    */
/* ------------------------------------------------------------------ */

const KEEP = /[\p{L}\p{N}]/u;
const WORDCH = /[\p{L}\p{N}\p{M}]/u;

// Sticky regexes: they only match exactly at lastIndex.
// HTML tag (attributes may span lines and contain quoted ">"); <https://autolinks> are NOT tags
const RE_TAG = /<\/?(?![a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s>]*>)[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">]){0,2000}>/y;
const RE_MACRO = /\{\{[^}\n]*\}\}/y;
const RE_ENTITY = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;
const RE_FENCE_BT = /`{3,}[^`\n]*(?:\n|$)/y;   // ```json  (info string can't contain backticks)
const RE_FENCE_TILDE = /~{3,}[^\n]*(?:\n|$)/y;

function sticky(re, str, i) {
    re.lastIndex = i;
    return re.test(str) ? re.lastIndex : -1;
}

function skipTag(str, i) {
    if (str.charCodeAt(i + 1) === 33 && str.startsWith('<!--', i)) { // HTML comment
        const e = str.indexOf('-->', i + 4);
        return e < 0 ? str.length : e + 3;
    }
    return sticky(RE_TAG, str, i);
}

// i is at "]" directly followed by "(": returns the index after the matching ")" or -1
function skipLinkDest(str, i) {
    let depth = 1;
    const lim = Math.min(str.length, i + 2000);
    for (let j = i + 2; j < lim; j++) {
        const ch = str.charCodeAt(j);
        if (ch === 10) return -1;
        if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) return j + 1;
    }
    return -1;
}

// i is at "![": skip the whole image (alt text isn't rendered as text)
function skipImage(str, i) {
    const lim = Math.min(str.length, i + 500);
    for (let j = i + 2; j < lim; j++) {
        const ch = str.charCodeAt(j);
        if (ch === 10) return -1;
        if (ch === 93 && str.charCodeAt(j + 1) === 40) return skipLinkDest(str, j);
    }
    return -1;
}

function atLineStart(str, i) {
    let j = i;
    while (j > 0 && i - j < 3 && str.charCodeAt(j - 1) === 32) j--;
    return j === 0 || str.charCodeAt(j - 1) === 10;
}

const keepCache = new Map();
// lowercase form of a code point if it is a letter/digit, otherwise ''
function keepChar(cp) {
    let v = keepCache.get(cp);
    if (v === undefined) {
        const ch = String.fromCodePoint(cp);
        v = KEEP.test(ch) ? ch.toLowerCase() : '';
        if (keepCache.size > 8000) keepCache.clear();
        keepCache.set(cp, v);
    }
    return v;
}

// Reduce a string to only letters/digits (lowercased), remembering where each kept
// character came from in the original string. This makes matching immune to markdown
// symbols, quotes, whitespace differences, <br> vs newlines, etc.
// For raw text, things that never show up as rendered text are skipped as well: HTML tags and
// comments, {{macros}}, entities, code fence lines (```json), and link / image targets.
// Inside code fences only macros are skipped, because everything else renders literally there.
function normalize(str, isRaw = false, withMap = true) {
    let text = '';
    const map = withMap ? [] : null;
    const n = str.length;
    let inFence = false;

    for (let i = 0; i < n;) {
        const c = str.charCodeAt(i);

        if (c < 128) {
            if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
                text += str[i];
                if (map) map.push(i);
            } else if (c >= 65 && c <= 90) {
                text += String.fromCharCode(c + 32);
                if (map) map.push(i);
            } else if (isRaw) {
                let next = -1;
                if (c === 123) { // {
                    if (str.charCodeAt(i + 1) === 123) next = sticky(RE_MACRO, str, i);
                } else if (!inFence) {
                    if (c === 60) next = skipTag(str, i);                                      // <
                    else if (c === 38) next = sticky(RE_ENTITY, str, i);                       // &
                    else if (c === 93 && str.charCodeAt(i + 1) === 40) next = skipLinkDest(str, i); // ](
                    else if (c === 33 && str.charCodeAt(i + 1) === 91) next = skipImage(str, i);    // ![
                }
                if ((c === 96 || c === 126) && atLineStart(str, i)) { // ` or ~
                    const f = sticky(c === 96 ? RE_FENCE_BT : RE_FENCE_TILDE, str, i);
                    if (f !== -1) { inFence = !inFence; i = f; continue; }
                }
                if (next !== -1) { i = next; continue; }
            }
            i++;
            continue;
        }

        const cp = str.codePointAt(i);
        const v = keepChar(cp);
        if (v) {
            text += v;
            if (map) for (let j = 0; j < v.length; j++) map.push(i);
        }
        i += cp > 0xFFFF ? 2 : 1;
    }
    return { text, map };
}

function findOccurrences(haystack, needle) {
    const out = [];
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        out.push(idx);
        idx = haystack.indexOf(needle, idx + 1);
    }
    return out;
}

// Given an index `k` into the normalized text `srcText`, find the matching index in the
// normalized text `dstText`. Exact when both are identical; otherwise matches the text
// around the index (centered, then only the text before it, then only the text after it,
// from long to short) and picks the closest occurrence to the same relative position.
function matchIndex(srcText, dstText, k) {
    if (srcText === dstText) return k;
    const sl = srcText.length;
    const expected = sl ? (k / sl) * dstText.length : 0;
    for (const size of [32, 20, 12, 8, 5, 3]) {
        for (let mode = 0; mode < 3; mode++) {
            let start;
            let end;
            if (mode === 0) { start = Math.max(0, k - size); end = Math.min(sl, k + size); }
            else if (mode === 1) { start = Math.max(0, k - size * 2); end = k; }
            else { start = k; end = Math.min(sl, k + size * 2); }
            if (end - start < 3) continue;
            const needle = srcText.slice(start, end);
            const occ = findOccurrences(dstText, needle);
            if (!occ.length) continue;
            let best = occ[0];
            let bestDist = Infinity;
            for (const o of occ) {
                const d = Math.abs(o + (k - start) - expected);
                if (d < bestDist) { bestDist = d; best = o; }
            }
            return best + (k - start);
        }
    }
    return Math.round(expected);
}

// number of entries in the sorted array that are < v
function countBelow(arr, v) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * @param {string} raw    the raw message text (what the edit textarea contains)
 * @param {string} before rendered text from the start of the message up to the caret
 * @param {string} full   the full rendered text of the message
 * @returns {number} index into raw
 */
function computeRawIndex(raw, before, full) {
    const R = normalize(full, false, false);
    const P = normalize(before, false, false);
    const W = normalize(raw, true);
    const k = P.text.length;

    if (!W.text.length) return raw.length;

    let a = matchIndex(R.text, W.text, k);

    a = Math.max(0, Math.min(W.text.length, a));

    // Number of non-letter chars (spaces, punctuation) directly before the caret
    const gapMatch = before.match(/[^\p{L}\p{N}]*$/u);
    const gap = gapMatch ? gapMatch[0].length : 0;

    const base = a > 0 ? W.map[a - 1] + 1 : 0;               // just after the previous letter
    const limit = a < W.text.length ? W.map[a] : raw.length; // just before the next letter

    // Caret sits right after whitespace -> it's at the start of the next word,
    // so skip over any markdown symbols in between (e.g. "** nice").
    if (gap > 0 && /\s$/.test(before)) return limit;

    return Math.min(base + gap, limit);
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

function isWordCh(str, i) {
    const c = str.charCodeAt(i);
    if (c !== c) return false; // NaN: out of range
    if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (c >= 0xD800 && c <= 0xDFFF) {
        // Treat astral letters/numbers/marks as word characters, but don't accidentally treat
        // every emoji or other surrogate-pair symbol as part of a word.
        if (c >= 0xDC00 && i > 0) {
            const prev = str.charCodeAt(i - 1);
            if (prev >= 0xD800 && prev <= 0xDBFF) {
                return WORDCH.test(String.fromCodePoint(str.codePointAt(i - 1)));
            }
        }
        if (c <= 0xDBFF && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                return WORDCH.test(String.fromCodePoint(str.codePointAt(i)));
            }
        }
        return false;
    }
    return WORDCH.test(str[i]);
}

// word character, or an apostrophe sitting between two word characters (don't, it's)
function isWordAt(str, i) {
    if (isWordCh(str, i)) return true;
    const c = str.charCodeAt(i);
    return (c === 39 || c === 8217) && i > 0 && isWordCh(str, i - 1) && isWordCh(str, i + 1);
}

let segmenter = null;

// [start, end) of the word containing the word character at index i
function expandWord(str, i) {
    const LIM = 200;
    let s = i;
    let e = i + 1;
    while (s > 0 && i - s < LIM && isWordAt(str, s - 1)) s--;
    while (e < str.length && e - i < LIM && isWordAt(str, e)) e++;
    if (e - s > 24) { // e.g. Chinese/Japanese text has no spaces: let the browser find the word
        try {
            segmenter = segmenter || new Intl.Segmenter(undefined, { granularity: 'word' });
            for (const seg of segmenter.segment(str.slice(s, e))) {
                const a = s + seg.index;
                const b = a + seg.segment.length;
                if (i >= a && i < b) return [a, b];
            }
        } catch { /* no Intl.Segmenter */ }
        return [i, Math.min(str.length, i + 1)];
    }
    return [s, e];
}

// Index of a word character that the caret at `pos` belongs to, or -1.
// "hel|lo" and "|hello" -> hello, "hello|" -> hello, "hello |world" -> world,
// "hello **|world**" -> world; a few punctuation/markup chars are skipped over.
function wordIndexNear(str, pos) {
    if (isWordAt(str, pos)) return pos;
    if (pos > 0 && isWordAt(str, pos - 1)) return pos - 1;
    for (let j = 1; j <= 4; j++) {
        if (str.charCodeAt(pos + j - 1) === 10) break;
        if (isWordAt(str, pos + j)) return pos + j;
    }
    for (let j = 1; j <= 4; j++) {
        if (pos - j >= 0 && str.charCodeAt(pos - j) === 10) break;
        if (isWordAt(str, pos - 1 - j)) return pos - 1 - j;
    }
    return -1;
}

/* ------------------------------------------------------------------ */
/* Caret / hit testing                                                 */
/* ------------------------------------------------------------------ */

const knownEditAreas = new WeakSet(); // fallback for SillyTavern versions with other ids/classes
const originalEditValues = new WeakMap(); // textarea -> raw text when this edit session began

function findEditTextarea(mes) {
    if (!mes) return null;
    return mes.querySelector('.mes_text textarea#curEditTextarea, .mes_text textarea.edit_textarea')
        ?? [...mes.querySelectorAll('.mes_text textarea')].find((ta) => knownEditAreas.has(ta))
        ?? null;
}

// The message's own editor (NOT a <textarea> that is part of the message's rendered HTML)
function isEditTextarea(el) {
    return !!el && el.tagName === 'TEXTAREA' && !!el.closest('.mes_text')
        && (el.id === 'curEditTextarea' || el.classList.contains('edit_textarea') || knownEditAreas.has(el));
}

function caretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
    }
    if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
}

function getRenderedContext(mesText, x, y) {
    const full = mesText.textContent || '';
    const pos = caretFromPoint(x, y);
    if (!pos || !mesText.contains(pos.node)) return { before: '', full };
    try {
        const range = document.createRange();
        range.setStart(mesText, 0);
        range.setEnd(pos.node, pos.offset);
        return { before: range.toString(), full };
    } catch {
        return { before: '', full };
    }
}

// The message text element under the given point, if it can be edited right now.
function hoveredMesText(x, y) {
    const el = document.elementFromPoint(x, y);
    const mesText = el?.closest?.('.mes_text');
    if (!mesText) return null;
    if (mesText.querySelector('textarea')) return null; // already editing, including unknown ST textarea variants
    return mesText;
}

/* ------------------------------------------------------------------ */
/* Highlighting the word at the caret                                  */
/* ------------------------------------------------------------------ */

// Tracks the real word selection we place in the editor, so save/cancel can still use the
// original caret position if the user finishes without changing that selection.
let activeHl = null; // { ta, start, end, pos }

function hlIntact() {
    const h = activeHl;
    if (!h) return null;
    if (!h.ta.isConnected) { activeHl = null; return null; }
    if (h.ta.selectionStart === h.start && h.ta.selectionEnd === h.end) return h;
    activeHl = null;
    return null;
}

// The caret position in the editor, even while its word is highlighted
function caretPos(ta) {
    const h = hlIntact();
    if (h && h.ta === ta) return h.pos;
    return ta.selectionStart ?? ta.value.length;
}

// Put the caret at pos, selecting the actual word it is on when highlighting is enabled
function placeCaret(ta, pos) {
    ta.focus({ preventScroll: true });
    activeHl = null;
    if (cfg().highlight) {
        const v = ta.value;
        const i = wordIndexNear(v, pos);
        if (i >= 0) {
            const [s, e] = expandWord(v, i);
            ta.setSelectionRange(s, e);
            activeHl = { ta, start: s, end: e, pos };
            return;
        }
    }
    ta.setSelectionRange(pos, pos);
}

function onBeforeInput(e) {
    // Do not collapse the browser selection here: the browser must replace the highlighted
    // word naturally when the user types, pastes, or deletes. Only discard our caret marker.
    if (activeHl && e.target === activeHl.ta) activeHl = null;
}

// Selecting the word in the rendered (non-edit) message
function highlightRendered(mesText, idx) {
    const full = mesText.textContent || '';
    if (idx == null || idx < 0 || idx >= full.length) return;
    const [s, e] = expandWord(full, idx);
    const range = rangeFromOffsets(mesText, s, e);
    if (!range) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

/* ------------------------------------------------------------------ */
/* Scrolling the caret under the mouse                                 */
/* ------------------------------------------------------------------ */

function measureCaretTop(textarea, pos) {
    const cs = getComputedStyle(textarea);
    const div = document.createElement('div');
    const props = [
        'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontKerning',
        'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'lineHeight',
        'textTransform', 'textIndent', 'textAlign', 'direction', 'tabSize', 'wordSpacing',
        'whiteSpace', 'overflowWrap', 'wordBreak',
    ];
    for (const p of props) div.style[p] = cs[p];
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.top = '0';
    div.style.left = '-9999px';
    div.style.whiteSpace = cs.whiteSpace || 'pre-wrap';
    div.style.overflowWrap = cs.overflowWrap || 'break-word';
    div.style.height = 'auto';
    div.textContent = textarea.value.slice(0, pos);
    const span = document.createElement('span');
    span.textContent = '\u200b';
    div.appendChild(span);
    document.body.appendChild(div);
    const top = span.offsetTop;
    const height = span.offsetHeight;
    div.remove();
    return { top, height };
}

function alignCaret(textarea, pos, mouseY) {
    const { top, height } = measureCaretTop(textarea, pos);

    // Textarea scrolls internally (fixed-height editor)
    if (textarea.scrollHeight > textarea.clientHeight + 2) {
        textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
    }

    const rect = textarea.getBoundingClientRect();
    const caretY = rect.top + textarea.clientTop + top - textarea.scrollTop + height / 2;
    const chat = document.getElementById('chat');
    if (chat) chat.scrollTop += caretY - mouseY;
}

/* ------------------------------------------------------------------ */
/* After an edit is saved or canceled                                  */
/* ------------------------------------------------------------------ */

let finishToken = 0; // newest "finishing an edit" run wins

// Viewport Y of the caret inside the edit textarea
function caretViewportY(textarea, pos) {
    const { top, height } = measureCaretTop(textarea, pos);
    const rect = textarea.getBoundingClientRect();
    return rect.top + textarea.clientTop + top - textarea.scrollTop + height / 2;
}

// Text node + offset for a character offset into root.textContent
function textPositionAt(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let node;
    while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        if (offset < acc + len) return { node, offset: offset - acc };
        acc += len;
    }
    return null;
}

// Range covering [s, e) of root.textContent
function rangeFromOffsets(root, s, e) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let node;
    let sNode = null;
    let sOff = 0;
    while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        if (!sNode && s < acc + len) { sNode = node; sOff = s - acc; }
        if (sNode && e <= acc + len) {
            const range = document.createRange();
            range.setStart(sNode, sOff);
            range.setEnd(node, e - acc);
            return range;
        }
        acc += len;
    }
    return null;
}

// Translate a caret position from a modified raw string to a related raw string. Used on
// cancel so the caret is mapped through the original text, not through edits that were discarded.
function mapRawPosition(fromRaw, toRaw, pos) {
    if (fromRaw === toRaw) return Math.max(0, Math.min(toRaw.length, pos));

    const from = normalize(fromRaw, true);
    const to = normalize(toRaw, true);
    if (!to.text.length) return toRaw.length;

    const k = countBelow(from.map, Math.max(0, Math.min(fromRaw.length, pos)));
    const a = Math.max(0, Math.min(to.text.length, matchIndex(from.text, to.text, k)));
    const fromBase = k > 0 ? from.map[k - 1] + 1 : 0;
    const gap = fromRaw.slice(fromBase, Math.max(fromBase, Math.min(fromRaw.length, pos)));
    const toBase = a > 0 ? to.map[a - 1] + 1 : 0;
    const toLimit = a < to.text.length ? to.map[a] : toRaw.length;

    if (/\s$/.test(gap)) return toLimit;
    return Math.max(toBase, Math.min(toBase + gap.length, toLimit));
}

// Index into mesText.textContent of the letter/digit that the raw-text position `pos`
// corresponds to in the rendered message (or null).
function locateRendered(mesText, raw, pos) {
    const R = normalize(mesText.textContent || '');
    if (!R.text.length) return null;
    const W = normalize(raw, true);

    // How many letters/digits sit before the caret in the raw text
    const k = countBelow(W.map, pos);

    const a = Math.max(0, Math.min(R.text.length, matchIndex(W.text, R.text, k)));

    // Whitespace between the previous letter and the caret -> the caret belongs to the next
    // word (which may be on the next line); otherwise to the end of the previous word.
    let afterSpace = k === 0;
    if (!afterSpace) {
        const from = W.map[k - 1] + 1;
        afterSpace = /\s/.test(raw.slice(from, Math.max(from, pos)));
    }
    const useNext = a < R.text.length && (a === 0 || afterSpace);
    const li = useNext ? a : a - 1;
    return li >= 0 ? R.map[li] : null;
}

// Viewport Y of the character at `idx` in mesText.textContent
function rectYAt(mesText, idx) {
    const start = textPositionAt(mesText, idx);
    if (!start) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(start.node, Math.min(start.node.nodeValue.length, start.offset + 1));
    const rects = range.getClientRects();
    const r = rects.length ? rects[0] : range.getBoundingClientRect();
    if (!r || (!r.height && !r.top)) return null;
    return r.top + r.height / 2;
}

function applyFinish(state) {
    const chat = document.getElementById('chat');
    if (!chat) return;
    const mes = [...chat.querySelectorAll('.mes')].find((m) => m.getAttribute('mesid') === state.mesId);
    const mesText = mes?.querySelector('.mes_text');
    if (!mesText || findEditTextarea(mes)) return; // never restore over a newer, active edit
    const c = cfg();

    const idx = locateRendered(mesText, state.value, state.pos);

    // Selecting a rendered range can cause the browser to scroll it into view. Do that first,
    // then make the intended caret-position correction the last layout-changing operation.
    if (c.highlight && idx !== null) {
        try { highlightRendered(mesText, idx); } catch (err) { console.warn(LOG, 'highlight failed', err); }
    }

    if (c.scrollOnDone && idx !== null) {
        const y = rectYAt(mesText, idx);
        // If the mapping/geometry isn't trustworthy, leave the current scroll alone instead
        // of jumping to the top of the message as a misleading fallback.
        if (y === null) return;

        // Keep the caret at the same screen position it had in the editor. If that was
        // outside the visible chat area, bring it to the middle instead.
        const cr = chat.getBoundingClientRect();
        const margin = Math.min(40, cr.height / 4);
        let desired = state.y;
        if (desired === null || desired < cr.top + margin || desired > cr.bottom - margin) {
            desired = cr.top + cr.height / 2;
        }
        chat.scrollTop += y - desired;
    }
}

// Counts user input only while a finishing run is active, so nothing is listening otherwise
function watchUserInput(initialEvent = null) {
    let moved = false;
    const h = (e) => { if (e !== initialEvent) moved = true; };
    const types = ['wheel', 'touchstart', 'mousedown', 'keydown'];
    for (const t of types) window.addEventListener(t, h, { capture: true, passive: true });
    return {
        moved: () => moved,
        release() { for (const t of types) window.removeEventListener(t, h, true); },
    };
}

// Called right before SillyTavern applies (save) or discards (cancel) the edit,
// while the textarea still exists.
async function onEditFinishing(mes, textarea, reason = 'save', initialEvent = null) {
    const c = cfg();
    if (!c.enabled || (!c.scrollOnDone && !c.highlight)) return;
    const mesId = mes.getAttribute('mesid');
    const chat = document.getElementById('chat');
    if (mesId === null || !chat) return;

    const currentValue = textarea.value;
    const currentPos = caretPos(textarea);
    const originalValue = originalEditValues.get(textarea);
    const value = reason === 'cancel' && originalValue !== undefined ? originalValue : currentValue;
    const pos = reason === 'cancel' && originalValue !== undefined
        ? mapRawPosition(currentValue, originalValue, currentPos)
        : currentPos;
    const state = { mesId, pos, value, y: null };
    if (c.scrollOnDone) {
        try { state.y = caretViewportY(textarea, currentPos); } catch { /* fall back to centering */ }
    }

    const token = ++finishToken;
    // Watch from the start of the finishing sequence, not only after the editor disappears,
    // so scrolling immediately after Save/Cancel takes precedence over delayed restoration.
    // Ignore the event that initiated finishing (e.g. the Escape key itself).
    const watcher = watchUserInput(initialEvent);
    try {
        // Wait for SillyTavern to re-render the message without its editor. Match the attribute
        // directly instead of interpolating it into a CSS selector.
        const done = await waitFor(chat, () => {
            const m = [...chat.querySelectorAll('.mes')].find((item) => item.getAttribute('mesid') === mesId);
            return m && !findEditTextarea(m) ? m : null;
        }, 5000);
        if (!done || token !== finishToken || watcher.moved()) return;

        // Apply once layout has settled, then re-apply briefly in case something else nudges
        // the chat afterwards. Stop immediately if the user scrolls, clicks or types.
        await nextFrame();
        await nextFrame();
        for (const wait of [0, 150, 250]) {
            if (wait) await sleep(wait);
            if (token !== finishToken || watcher.moved()) return;
            const currentMes = [...chat.querySelectorAll('.mes')].find((m) => m.getAttribute('mesid') === mesId);
            if (!currentMes || findEditTextarea(currentMes)) return;
            applyFinish(state);
        }
    } finally {
        watcher.release();
    }
}

/* ------------------------------------------------------------------ */
/* Main action                                                         */
/* ------------------------------------------------------------------ */

// Wait until the textarea has stopped resizing (SillyTavern auto-sizes it)
async function settleLayout(el, maxFrames = 8) {
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < maxFrames; i++) {
        await nextFrame();
        const h = el.offsetHeight;
        stable = h === prev ? stable + 1 : 0;
        prev = h;
        if (stable >= 2) return;
    }
}

async function editAtPoint(x, y) {
    const mesText = hoveredMesText(x, y);
    if (!mesText) return;

    const mes = mesText.closest('.mes');
    const editBtn = mes?.querySelector('.mes_edit');
    if (!editBtn) return;

    // Capture rendered context BEFORE entering edit mode (the DOM will change)
    const { before, full } = getRenderedContext(mesText, x, y);
    const existing = new Set(mes.querySelectorAll('textarea'));

    // Invalidate any delayed restoration from an older save/cancel before this edit begins.
    finishToken++;
    editBtn.click();

    const textarea = await waitFor(mes, () => {
        const ta = findEditTextarea(mes);
        if (ta) return ta;
        for (const t of mes.querySelectorAll('.mes_text textarea')) {
            if (!existing.has(t)) { knownEditAreas.add(t); return t; }
        }
        return null;
    }, 1500);
    if (!textarea) return;
    originalEditValues.set(textarea, textarea.value);

    const initialValue = textarea.value;
    const pos = Math.min(computeRawIndex(initialValue, before, full), initialValue.length);

    placeCaret(textarea, pos);

    // Let the textarea finish auto-sizing, then align it under the mouse. If the user has
    // already typed or moved the caret while the layout settled, don't steal focus/selection
    // back or overwrite their interaction with the initial hover position.
    await settleLayout(textarea);
    if (!textarea.isConnected || textarea.value !== initialValue) return;
    const marker = hlIntact();
    const selectionUnchanged = marker?.ta === textarea
        || (!marker && textarea.selectionStart === pos && textarea.selectionEnd === pos);
    if (!selectionUnchanged) return;

    if (cfg().alignCaret) {
        try { alignCaret(textarea, pos, y); } catch (err) { console.warn(LOG, 'caret alignment failed', err); }
    }
    // Reapply the highlight only if it remains our untouched selection.
    if (textarea.value === initialValue && textarea.isConnected) placeCaret(textarea, pos);
}

async function trigger() {
    if (busy) return;
    busy = true;
    try {
        await editAtPoint(lastX, lastY);
    } catch (err) {
        console.error(LOG, err);
    } finally {
        busy = false;
    }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Keys pressed inside a message editor. Returns true when the key was consumed.
function handleEditorKey(e) {
    const ta = e.target;
    const mes = ta.closest('.mes');
    if (!mes || e.isComposing) return false;
    const c = cfg();

    // Our own save hotkey (only when it isn't SillyTavern's built-in Ctrl + Enter)
    if (c.enabled && !e.repeat && !isNativeSave(c.saveHotkey) && hotkeyMatches(e, c.saveHotkey)) {
        const doneBtn = mes.querySelector('.mes_edit_done');
        if (doneBtn) {
            e.preventDefault();
            e.stopImmediatePropagation();
            doneBtn.click(); // the click handler takes care of scrolling / highlighting
            return true;
        }
    }

    // Cancel (Esc) and SillyTavern's own Ctrl/Cmd + Enter save: SillyTavern does the work,
    // we only remember where the caret is so we can take you back to it afterwards.
    if (e.key === 'Escape') {
        onEditFinishing(mes, ta, 'cancel', e).catch((err) => console.warn(LOG, err));
        return false;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        onEditFinishing(mes, ta, 'save', e).catch((err) => console.warn(LOG, err));
        return false;
    }

    // Leave the real selection intact. Normal browser editing replaces the selected word;
    // cursor-navigation keys also keep their standard selection behavior.
    return false;
}

function onKeyDown(e) {
    // Hotkey capture mode (started from the settings buttons)
    if (capturing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (MODIFIER_CODES.includes(e.code)) return; // wait for the real key
        if (e.code === 'Escape') {
            capturing = null;
            refreshHotkeyButtons();
            return;
        }
        // The save hotkey is pressed while typing, so a plain letter/space would break typing
        if (capturing === 'save' && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
            window.toastr?.warning('The save hotkey needs Ctrl, Alt or Meta (or a non-typing key like F2).', 'Hover Edit');
            return;
        }
        const hk = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
        if (capturing === 'save') cfg().saveHotkey = hk; else cfg().hotkey = hk;
        capturing = null;
        saveSettingsDebounced();
        refreshHotkeyButtons();
        return;
    }

    if (isEditTextarea(e.target) && handleEditorKey(e)) return;

    if (!cfg().enabled || e.repeat) return;
    const hk = cfg().hotkey;
    if (!hotkeyMatches(e, hk)) return;

    // Don't hijack plain keys while the user is typing somewhere
    const hasModifier = hk.ctrl || hk.alt || hk.meta;
    if (!hasModifier && isEditable(e.target)) return;

    if (!hoveredMesText(lastX, lastY)) return;

    e.preventDefault();
    e.stopPropagation();
    trigger();
}

function onMouseMove(e) {
    lastX = e.clientX;
    lastY = e.clientY;
}

// Clicking anywhere else cancels hotkey capture
function onMouseDown(e) {
    if (capturing && !e.target.closest?.('.hover_edit_hotkey_btn')) {
        capturing = null;
        refreshHotkeyButtons();
    }
}

// Clicking in the editor means the user is placing their own caret / selection
function onPointerDown(e) {
    if (activeHl && e.target === activeHl.ta) activeHl = null;
}

// Clicking the checkmark (save) or the X (cancel). Capture phase, so the textarea still exists.
function onClickCapture(e) {
    const btn = e.target?.closest?.('.mes_edit_done, .mes_edit_cancel');
    if (btn) {
        const mes = btn.closest('.mes');
        const textarea = findEditTextarea(mes);
        if (!textarea) return;
        const reason = btn.matches('.mes_edit_cancel') ? 'cancel' : 'save';
        onEditFinishing(mes, textarea, reason, e).catch((err) => console.warn(LOG, err));
        return;
    }

    // A pending save/cancel restoration must never override a newer edit session. Also
    // remember the initial raw value for edits started from SillyTavern's own edit button.
    const editBtn = e.target?.closest?.('.mes_edit');
    if (!editBtn) return;
    finishToken++;
    const mes = editBtn.closest('.mes');
    if (!mes) return;
    const existing = new Set(mes.querySelectorAll('.mes_text textarea'));
    waitFor(mes, () => {
        let textarea = findEditTextarea(mes);
        if (!textarea) {
            textarea = [...mes.querySelectorAll('.mes_text textarea')].find((ta) => !existing.has(ta)) ?? null;
            if (textarea) knownEditAreas.add(textarea);
        }
        if (!textarea) return null;
        if (!originalEditValues.has(textarea)) originalEditValues.set(textarea, textarea.value);
        return textarea;
    }, 1500).catch((err) => console.warn(LOG, 'could not capture edit baseline', err));
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

function refreshHotkeyButtons() {
    $('#hover_edit_hotkey_btn').text(capturing === 'edit' ? 'Press a key combo… (Esc to cancel)' : hotkeyLabel(cfg().hotkey));
    $('#hover_edit_save_hotkey_btn').text(capturing === 'save' ? 'Press a key combo… (Esc to cancel)' : hotkeyLabel(cfg().saveHotkey));
    $('#hover_edit_save_note').text(isNativeSave(cfg().saveHotkey)
        ? 'Ctrl + Enter is already built into SillyTavern, so Hover Edit leaves the saving to it and only watches it (to scroll back and highlight). Pick another combo and Hover Edit saves the edit itself.'
        : 'Hover Edit saves the edit with this combo while you are typing in a message editor. SillyTavern\'s own Ctrl + Enter still works too.');
}

function buildSettingsUI() {
    const html = `
    <div class="hover_edit_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Hover Edit</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="hover_edit_enabled">
                    <input type="checkbox" id="hover_edit_enabled" />
                    <span>Enabled</span>
                </label>
                <label class="checkbox_label" for="hover_edit_align">
                    <input type="checkbox" id="hover_edit_align" />
                    <span>Scroll so the caret lands under the mouse</span>
                </label>
                <label class="checkbox_label" for="hover_edit_scroll_done">
                    <input type="checkbox" id="hover_edit_scroll_done" />
                    <span>After saving or canceling an edit, scroll to where the caret was</span>
                </label>
                <label class="checkbox_label" for="hover_edit_highlight">
                    <input type="checkbox" id="hover_edit_highlight" />
                    <span>Highlight the word at the caret (entering, saving, canceling)</span>
                </label>
                <div style="margin-top:8px;">
                    <small>Edit hotkey (hover a message, then press it):</small>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <div id="hover_edit_hotkey_btn" class="menu_button hover_edit_hotkey_btn" style="flex:1;"></div>
                        <div id="hover_edit_reset_btn" class="menu_button" title="Reset to Alt + E">Reset</div>
                    </div>
                    <small style="opacity:0.7; display:block; margin-top:4px;">
                        Keys without Ctrl/Alt/Meta are ignored while you're typing in a text box.
                    </small>
                </div>
                <div style="margin-top:8px;">
                    <small>Save hotkey (while editing a message):</small>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <div id="hover_edit_save_hotkey_btn" class="menu_button hover_edit_hotkey_btn" style="flex:1;"></div>
                        <div id="hover_edit_save_reset_btn" class="menu_button" title="Reset to Ctrl + Enter">Reset</div>
                    </div>
                    <small id="hover_edit_save_note" style="opacity:0.7; display:block; margin-top:4px;"></small>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const bind = (id, key) => {
        $(id).prop('checked', cfg()[key]).on('input', function () {
            cfg()[key] = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    };
    bind('#hover_edit_enabled', 'enabled');
    bind('#hover_edit_align', 'alignCaret');
    bind('#hover_edit_scroll_done', 'scrollOnDone');
    bind('#hover_edit_highlight', 'highlight');

    $('#hover_edit_hotkey_btn').on('click', () => {
        capturing = 'edit';
        refreshHotkeyButtons();
    });
    $('#hover_edit_save_hotkey_btn').on('click', () => {
        capturing = 'save';
        refreshHotkeyButtons();
    });
    $('#hover_edit_reset_btn').on('click', () => {
        cfg().hotkey = { ...HOTKEY_EDIT_DEFAULT };
        capturing = null;
        saveSettingsDebounced();
        refreshHotkeyButtons();
    });
    $('#hover_edit_save_reset_btn').on('click', () => {
        cfg().saveHotkey = { ...HOTKEY_SAVE_DEFAULT };
        capturing = null;
        saveSettingsDebounced();
        refreshHotkeyButtons();
    });
    refreshHotkeyButtons();
}

jQuery(() => {
    loadSettings();
    buildSettingsUI();
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClickCapture, true);
    for (const type of ['beforeinput', 'paste', 'compositionstart']) {
        document.addEventListener(type, onBeforeInput, true);
    }
    console.log(LOG, 'loaded');
});
