# Hover Edit

A quality of life [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that lets you hover your mouse right where you want to edit a message, press a hotkey, and be instantly brought to that exact spot in edit mode, instead of having to scroll and read through the edit box to find it first.

## Features

- **Hover + hotkey editing.** Point at a word in any message, press the hotkey, and the message switches to edit mode with the text caret already sitting where your mouse was.
- **Works with the mouse alone (optional).** Turn on **Click a word in a message to edit it** and a click does what the edit hotkey does, at the word you clicked (optionally on a double click). Turn on **Click outside the editor to save the edit** and clicking anywhere outside the edit box saves it. Neither needs a hotkey. Both are off by default.
- **Fully rebindable hotkey.** Click the hotkey button in the settings, press whatever combination you want (with or without Ctrl / Alt / Shift / Meta), done. Default: `Alt + E`.
- **Caret stays under your mouse.** After entering edit mode, the chat scrolls so the caret lands where your cursor is, so the text doesn't jump away from where you were looking. This can be turned off.
- **Scrolls back to your caret when you finish, whether you save or cancel.** When you save an edit (checkmark, Ctrl/Cmd + Enter, or your own save hotkey) or cancel it (X button or `Esc`), the chat scrolls to the spot in the rendered message where your caret was, at the same screen position, instead of jumping to the top or bottom of the message. This can be turned off.
- **Selects the word at the caret.** When you enter edit mode, the word under the caret is a real text selection. Start typing, paste, or delete to replace that word just like any other selected text. Arrow keys and other selection commands keep their normal browser behavior. After saving or canceling, the corresponding word is highlighted in the rendered message. This can be turned off.
- **Rebindable save hotkey.** Default `Ctrl + Enter`, which SillyTavern already handles itself, so Hover Edit leaves the saving to it (and only watches it). Rebind it to anything else and Hover Edit saves the edit itself.
- **Markdown and format aware.** Works with messages containing `*actions*`, `**bold**`, quotes, HTML (including multi-line tags and comments), `{{macros}}`, entities, links and images, numbered lists, and code blocks such as fenced JSON, even though the edit box shows different text than the rendered message.
- Works on user messages, character messages, and swipes.

## Installation

### From inside SillyTavern (recommended)

1. Open the **Extensions** panel (the stacked-blocks icon).
2. Click **Install extension**.
3. Paste this URL and confirm:

   ```
   https://github.com/serioos/Hover-Edit
   ```

4. Reload SillyTavern if it doesn't refresh on its own.

Installing this way also lets SillyTavern update the extension for you.

### Manual

1. Download or clone this repository.
2. Put the folder (named `Hover-Edit`) in your SillyTavern extensions directory:
   - `data/<your-user>/extensions/` (usually `data/default-user/extensions/`), or
   - `public/scripts/extensions/third-party/` on older versions.
3. Reload SillyTavern.

## Usage

1. Move your mouse over the exact spot in a message you want to change.
2. Press the hotkey (default `Alt + E`).
3. The word at the caret is selected when highlighting is enabled. Start typing to replace it, or use the arrow keys to move the caret normally.

Open **Extensions → Hover Edit** to change settings.

| Setting | What it does |
| --- | --- |
| Enabled | Turns the extension on or off. |
| Scroll so the caret lands under the mouse | After entering edit mode, scrolls the chat so the caret is at the same screen position your mouse was. |
| After saving or canceling an edit, scroll to where the caret was | When an edit is saved or canceled, scrolls the chat so the rendered text at your last caret position is where the caret was on screen (or centered if it was off-screen). Stops if you scroll, click or type. |
| Highlight the word at the caret | Selects the word at the caret in the editor, and highlights the corresponding word in the rendered message after saving or canceling. The editor selection is real, so typing replaces the selected word. |
| Click a word in a message to edit it | A click on a word does the same as the edit hotkey. Links, images, buttons and other clickable things inside messages keep their normal behavior, clicks on spaces or punctuation are ignored, and dragging to select text never starts an edit. Ctrl, Alt, Shift or Meta clicks are ignored too. |
| Require a double click | Makes click-to-edit need a double click instead of a single click, to avoid accidental edits. |
| Click outside the editor to save the edit | Clicking outside the message editor presses its save (checkmark) button, so scrolling back and highlighting work as usual. Clicks on message buttons (the X to cancel, delete, copy...) and in popups are left alone. Selecting text in the editor and releasing the mouse outside it does not save. Use the X button or `Esc` to cancel. |
| Edit hotkey | Click the button, then press the combination you want. `Esc` cancels, clicking elsewhere cancels, and **Reset** restores `Alt + E`. |
| Save hotkey | Same way. Default `Ctrl + Enter` (handled by SillyTavern itself, so Hover Edit doesn't act on it). Needs Ctrl, Alt or Meta (or an `F` key like `F2`) since you press it while typing. **Reset** restores `Ctrl + Enter`. |

**Notes**

- A hotkey with no modifier (for example just `E`) is ignored while you're typing in a text box, so it can't interfere with normal typing. Combinations that include Ctrl, Alt, or Meta work everywhere.
- The hotkey only does something when your mouse is over the text of a message that isn't already being edited.
- With **Click outside the editor to save** on, the click that saves the edit only saves it. It does not also start a new edit, so click again to edit another message.

## How it works

What you see in the chat is rendered text, but the edit box contains the raw text (markdown symbols, macros, and so on), so a simple character offset doesn't line up. Hover Edit:

1. Finds which character in the rendered message is under your mouse.
2. Reduces both the rendered and raw text to just their letters and numbers, ignoring markdown, punctuation, whitespace differences, and things that never render as text (HTML tags and comments, `{{macros}}`, entities, code fence lines like ` ```json `, link and image targets). Inside code blocks everything is kept as is, since it renders literally.
3. Matches the text around your mouse (centered, before, and after it) against the raw text to find the same spot, then places the caret there.

It only maps text when you invoke editing or finish an edit; it does not poll the chat. Click options are handled by a single click listener that does nothing while they are off. Temporary listeners are used only while a save/cancel restoration is running.

## Limitations and troubleshooting

- In unusual cases, such as heavy regex-script replacements, or a phrase repeated many times in one message, the caret can land a few words from where you pointed. It picks the closest match to the same relative position in the message.
- The hotkey is hover-based, so it isn't useful on touch-only devices. The click options also work with taps if you turn them on.
- If the hotkey does nothing, check that **Enabled** is on, that your mouse is over message text, and that the combination isn't being captured by your OS or browser. Try rebinding it.
- Found a bug? Please [open an issue](https://github.com/serioos/Hover-Edit/issues) and include your SillyTavern version, your browser, and a short description of the message you were hovering.

## License

[MIT](LICENSE)
