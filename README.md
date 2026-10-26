# Hover Edit

A quality of life [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that lets you hover your mouse right where you want to edit a message, press a hotkey, and be instantly brought to that exact spot in edit mode, instead of having to scroll and read through the edit box to find it first.

## Features

- **Hover + hotkey editing.** Point at a word in any message, press the hotkey, and the message switches to edit mode with the text caret already sitting where your mouse was.
- **Fully rebindable hotkey.** Click the hotkey button in the settings, press whatever combination you want (with or without Ctrl / Alt / Shift / Meta), done. Default: `Alt + E`.
- **Caret stays under your mouse.** After entering edit mode, the chat scrolls so the caret lands where your cursor is, so the text doesn't jump away from where you were looking. This can be turned off.
- **Scrolls back to your caret when you finish.** When you apply an edit (checkmark button or Ctrl/Cmd + Enter), the chat scrolls to the spot in the rendered message where your caret was, at the same screen position, instead of jumping to the top or bottom of the message. This can be turned off.
- **Markdown aware.** Works with messages containing `*actions*`, `**bold**`, quotes, HTML such as `<br>`, and `{{macros}}`, even though the edit box shows different text than the rendered message.
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
3. Start typing. The caret is already there.

Open **Extensions → Hover Edit** to change settings.

| Setting | What it does |
| --- | --- |
| Enabled | Turns the extension on or off. |
| Scroll so the caret lands under the mouse | After entering edit mode, scrolls the chat so the caret is at the same screen position your mouse was. |
| After finishing an edit, scroll to where the caret was | When an edit is applied, scrolls the chat so the rendered text at your last caret position is where the caret was on screen (or centered if it was off-screen). Stops if you scroll or type. |
| Hotkey | Click the button, then press the combination you want. `Esc` cancels, clicking elsewhere cancels, and **Reset** restores `Alt + E`. |

**Notes**

- A hotkey with no modifier (for example just `E`) is ignored while you're typing in a text box, so it can't interfere with normal typing. Combinations that include Ctrl, Alt, or Meta work everywhere.
- The hotkey only does something when your mouse is over the text of a message that isn't already being edited.

## How it works

What you see in the chat is rendered text, but the edit box contains the raw text (markdown symbols, macros, and so on), so a simple character offset doesn't line up. Hover Edit:

1. Finds which character in the rendered message is under your mouse.
2. Reduces both the rendered and raw text to just their letters and numbers, ignoring markdown, punctuation, HTML tags, `{{macros}}`, and whitespace differences.
3. Matches the text around your mouse against the raw text to find the same spot, then places the caret there.

## Limitations and troubleshooting

- In unusual cases, such as heavy regex-script replacements, or a phrase repeated many times in one message, the caret can land a few words from where you pointed. It picks the closest match to the same relative position in the message.
- Hover-based, so it's designed for mouse use and isn't useful on touch-only devices.
- If the hotkey does nothing, check that **Enabled** is on, that your mouse is over message text, and that the combination isn't being captured by your OS or browser. Try rebinding it.
- Found a bug? Please [open an issue](https://github.com/serioos/Hover-Edit/issues) and include your SillyTavern version, your browser, and a short description of the message you were hovering.

## License

[MIT](LICENSE)
