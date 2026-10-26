// Hover Edit - SillyTavern extension
// Hover over text in a message, press a hotkey, and jump straight into edit mode
// with the caret placed exactly where your mouse was.
// https://github.com/serioos/Hover-Edit

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'hover_edit';
const LOG = '[Hover Edit]';

const defaultSettings = {
    enabled: true,
    alignCaret: true, // scroll the chat so the caret ends up under the mouse
    scrollOnDone: true, // after an edit is applied, scroll to where the caret was
    hotkey: { code: 'KeyE', ctrl: false, alt: true, shift: false, meta: false },
};

let lastX = 0;
let lastY = 0;
let capturing = false; // true while waiting for the user to press a new hotkey
let busy = false;      // guards against double triggers while entering edit mode

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function loadSettings() {
    extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE]);
    extension_settings[MODULE].hotkey = Object.assign({}, defaultSettings.hotkey, extension_settings[MODULE].hotkey);
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

const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];

/* ------------------------------------------------------------------ */
/* Text mapping: rendered text -> raw markdown text                    */
/* ------------------------------------------------------------------ */

const KEEP = /[\p{L}\p{N}]/u;
const HTML_TAG = /<\/?[a-zA-Z][^>\n]*>/y; // sticky: only matches at lastIndex
const MACRO = /\{\{[^}\n]*\}\}/y;

// Reduce a string to only letters/digits (lowercased), remembering where each
// kept character came from in the original string. This makes matching immune to
// markdown symbols, quotes, whitespace differences, <br> vs newlines, etc.
// For raw text, HTML tags and {{macros}} are skipped since they don't render as text.
function normalize(str, isRaw = false) {
    let text = '';
    const map = [];
    for (let i = 0; i < str.length;) {
        if (isRaw) {
            const c = str[i];
            if (c === '<') {
                HTML_TAG.lastIndex = i;
                const m = HTML_TAG.exec(str);
                if (m) { i += m[0].length; continue; }
            } else if (c === '{' && str[i + 1] === '{') {
                MACRO.lastIndex = i;
                const m = MACRO.exec(str);
                if (m) { i += m[0].length; continue; }
            }
        }
        const cp = str.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        if (KEEP.test(ch)) {
            const lower = ch.toLowerCase();
            for (let j = 0; j < lower.length; j++) map.push(i);
            text += lower;
        }
        i += ch.length;
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
// around the index and picks the closest occurrence to the same relative position.
function matchIndex(srcText, dstText, k) {
    if (srcText === dstText) return k;
    const expected = srcText.length ? (k / srcText.length) * dstText.length : 0;
    for (const size of [24, 14, 8, 5, 3]) {
        const start = Math.max(0, k - size);
        const end = Math.min(srcText.length, k + size);
        const needle = srcText.slice(start, end);
        if (needle.length < 3) continue;
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
    return Math.round(expected);
}

/**
 * @param {string} raw    the raw message text (what the edit textarea contains)
 * @param {string} before rendered text from the start of the message up to the caret
 * @param {string} full   the full rendered text of the message
 * @returns {number} index into raw
 */
function computeRawIndex(raw, before, full) {
    const R = normalize(full);
    const P = normalize(before);
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
/* Caret / hit testing                                                 */
/* ------------------------------------------------------------------ */

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
    const mesText = el?.closest('.mes_text');
    if (!mesText) return null;
    if (mesText.querySelector('textarea')) return null; // already editing
    return mesText;
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
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
        'textTransform', 'textIndent', 'tabSize', 'wordSpacing',
    ];
    for (const p of props) div.style[p] = cs[p];
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.top = '0';
    div.style.left = '-9999px';
    div.style.whiteSpace = 'pre-wrap';
    div.style.overflowWrap = 'break-word';
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
/* Scrolling to the caret after an edit is applied                     */
/* ------------------------------------------------------------------ */

let finishToken = 0;   // newest "finishing an edit" run wins
let userInputs = 0;    // bumped on wheel/touch/mouse/key input, so we never fight the user

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

// Viewport Y of the spot in the rendered message that corresponds to `pos` in the raw text
function renderedCaretY(mesText, raw, pos) {
    const R = normalize(mesText.textContent || '');
    if (!R.text.length) return null;
    const W = normalize(raw, true);

    // How many letters/digits sit before the caret in the raw text
    let k = 0;
    while (k < W.map.length && W.map[k] < pos) k++;

    const a = Math.max(0, Math.min(R.text.length, matchIndex(W.text, R.text, k)));

    // Caret right after whitespace -> it belongs to the next word (which may be on the
    // next line); otherwise it belongs to the end of the previous word.
    const afterSpace = pos > 0 && /\s$/.test(raw.slice(0, pos));
    const useNext = a < R.text.length && (a === 0 || afterSpace);
    const start = textPositionAt(mesText, R.map[useNext ? a : a - 1]);
    if (!start) return null;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(start.node, Math.min(start.node.nodeValue.length, start.offset + 1));
    const rects = range.getClientRects();
    const r = rects.length ? rects[0] : range.getBoundingClientRect();
    if (!r || (!r.height && !r.top)) return null;
    return r.top + r.height / 2;
}

function scrollToEditedCaret(state) {
    const chat = document.getElementById('chat');
    const mesText = document.querySelector(`#chat .mes[mesid="${state.mesId}"] .mes_text`);
    if (!chat || !mesText) return;

    let y = renderedCaretY(mesText, state.value, state.pos);
    if (y === null) y = mesText.getBoundingClientRect().top;

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

// Called right before SillyTavern applies the edit (textarea still exists).
async function onEditFinishing(mes, textarea) {
    if (!cfg().enabled || !cfg().scrollOnDone) return;
    const mesId = mes.getAttribute('mesid');
    if (mesId === null) return;

    const pos = textarea.selectionStart ?? textarea.value.length;
    const state = { mesId, pos, value: textarea.value, y: null };
    try { state.y = caretViewportY(textarea, pos); } catch { /* fall back to centering */ }

    const token = ++finishToken;
    await sleep(0); // let the triggering event finish before we start counting user input
    const inputsAtStart = userInputs;

    // Wait for SillyTavern to apply the edit and re-render the message
    let applied = false;
    for (let i = 0; i < 80 && token === finishToken; i++) {
        const m = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        if (m && !m.querySelector('.mes_text textarea')) { applied = true; break; }
        await sleep(25);
    }
    if (!applied) return;

    // Scroll once layout has settled, then re-apply briefly in case something else
    // nudges the chat afterwards. Stop immediately if the user scrolls or types.
    await nextFrame();
    await nextFrame();
    for (const wait of [0, 150, 250]) {
        if (wait) await sleep(wait);
        if (token !== finishToken || userInputs !== inputsAtStart) return;
        scrollToEditedCaret(state);
    }
}

/* ------------------------------------------------------------------ */
/* Main action                                                         */
/* ------------------------------------------------------------------ */


async function editAtPoint(x, y) {
    const mesText = hoveredMesText(x, y);
    if (!mesText) return;

    const mes = mesText.closest('.mes');
    const editBtn = mes?.querySelector('.mes_edit');
    if (!editBtn) return;

    // Capture rendered context BEFORE entering edit mode (the DOM will change)
    const { before, full } = getRenderedContext(mesText, x, y);

    editBtn.click();

    let textarea = null;
    for (let i = 0; i < 40 && !textarea; i++) {
        textarea = mes.querySelector('textarea');
        if (!textarea) await sleep(25);
    }
    if (!textarea) return;

    const pos = Math.min(computeRawIndex(textarea.value, before, full), textarea.value.length);

    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(pos, pos);

    // Let the textarea finish auto-sizing, then align it under the mouse
    await sleep(60);
    if (cfg().alignCaret) {
        try { alignCaret(textarea, pos, y); } catch (err) { console.warn(LOG, 'caret alignment failed', err); }
    }
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(pos, pos);
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

function onKeyDown(e) {
    // Hotkey capture mode (started from the settings button)
    if (capturing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (MODIFIER_CODES.includes(e.code)) return; // wait for the real key
        capturing = false;
        if (e.code !== 'Escape') {
            cfg().hotkey = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
            saveSettingsDebounced();
        }
        refreshHotkeyButton();
        return;
    }

    // Ctrl/Cmd + Enter inside a message editor applies the edit
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target?.tagName === 'TEXTAREA') {
        const mes = e.target.closest('.mes_text') && e.target.closest('.mes');
        if (mes) onEditFinishing(mes, e.target).catch((err) => console.warn(LOG, err));
    }

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
    if (capturing && !e.target.closest?.('#hover_edit_hotkey_btn')) {
        capturing = false;
        refreshHotkeyButton();
    }
}

// Clicking the checkmark that applies an edit. Capture phase, so the textarea still exists.
function onClickCapture(e) {
    const btn = e.target.closest?.('.mes_edit_done');
    if (!btn) return;
    const mes = btn.closest('.mes');
    const textarea = mes?.querySelector('.mes_text textarea');
    if (textarea) onEditFinishing(mes, textarea).catch((err) => console.warn(LOG, err));
}

function onUserInput() {
    userInputs++;
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

function refreshHotkeyButton() {
    const btn = $('#hover_edit_hotkey_btn');
    btn.text(capturing ? 'Press a key combo… (Esc to cancel)' : hotkeyLabel(cfg().hotkey));
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
                    <span>After finishing an edit, scroll to where the caret was</span>
                </label>
                <div style="margin-top:8px;">
                    <small>Hotkey (hover a message, then press it):</small>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <div id="hover_edit_hotkey_btn" class="menu_button" style="flex:1;"></div>
                        <div id="hover_edit_reset_btn" class="menu_button" title="Reset to Alt + E">Reset</div>
                    </div>
                    <small style="opacity:0.7; display:block; margin-top:4px;">
                        Keys without Ctrl/Alt/Meta are ignored while you're typing in a text box.
                    </small>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#hover_edit_enabled').prop('checked', cfg().enabled).on('input', function () {
        cfg().enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#hover_edit_align').prop('checked', cfg().alignCaret).on('input', function () {
        cfg().alignCaret = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#hover_edit_scroll_done').prop('checked', cfg().scrollOnDone).on('input', function () {
        cfg().scrollOnDone = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#hover_edit_hotkey_btn').on('click', () => {
        capturing = true;
        refreshHotkeyButton();
    });
    $('#hover_edit_reset_btn').on('click', () => {
        cfg().hotkey = Object.assign({}, defaultSettings.hotkey);
        capturing = false;
        saveSettingsDebounced();
        refreshHotkeyButton();
    });
    refreshHotkeyButton();
}

jQuery(() => {
    loadSettings();
    buildSettingsUI();
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClickCapture, true);
    for (const type of ['wheel', 'touchstart', 'mousedown', 'keydown']) {
        window.addEventListener(type, onUserInput, { capture: true, passive: true });
    }
    console.log(LOG, 'loaded');
});
