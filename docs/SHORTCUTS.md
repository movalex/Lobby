# Lobby keyboard shortcuts (new canvas)

On a Mac, **Ctrl is Cmd** and **Alt is Option**. Press **?** on any board to see this list inside Lobby.

Shortcuts do not fire while you are typing in a text box, a menu or a dialog. The zoom keys, Ctrl+F
and Undo/Redo also work while the keyboard is on a panel or button rather than on the board.

Every shortcut on this page was read from the app's code: first on 30 September 2026 (`engine/excalidraw` 5caee00), and
again on 3 October 2026 at `release/held` 99ac6c52 for every file that changed since (the rows added or changed on that
date are marked *(3 Oct)*). It was read from the code, not tried key by key on a live board; the specs named in the
comment at the end pin most of it. The two rows marked *(engine default)* come from the drawing engine's own behaviour,
which Lobby passes through but does not test itself.

## Tools

| Key | Tool |
|---|---|
| **V** | Select |
| **H** | Hand (pan) |
| **N** | Sticky note |
| **T** | Text |
| **R** | Rectangle |
| **O** | Ellipse |
| **P** | Pen |
| **Shift+D** | Highlighter (press **P** to go back to the pen) |
| **L** | Connector |
| **F** | Frame |
| **C** | Comment |
| **E** | Eraser |
| **K** | Laser pointer |
| **Alt+Shift+M** | Start a mind map |

Triangle, Diamond, Hexagon, Rhombus, Star, Cloud, Heart, the block arrows, Line and Lasso select have no
key: open **More** on the toolbar (with the keyboard: Tab to More, then **Enter** and the arrow keys).

If exactly one sticky note is selected, letters type into it instead of picking a tool. Press **Esc** or
click empty canvas first.

People who can only view or comment get **V**, **H**, **C**, the zoom keys and, where the board's export setting lets them copy,
**Ctrl+C**, which copies the words of the selection as plain text *(3 Oct)*.

## Sticky notes and text

| Key | What it does |
|---|---|
| Any letter | Type into the one selected note |
| **Enter** | Edit the selected note or text (cursor at the end) |
| **Enter** | Rename the selected frame |
| **Enter** | With Note, Text or a shape tool picked: place one in the middle of the view, ready to type |
| **Tab** / **Shift+Tab** | While typing in a note: a new note beside it / before it |
| **Ctrl+Enter** / **Ctrl+Shift+Enter** | While typing in a note: a new note below it / above it |
| **Esc** | Finish typing (the note stays selected) |
| **Enter** or **Esc** | With an image's crop open: finish the crop *(3 Oct)* |
| Double-click empty canvas | New sticky note |
| **Ctrl+V** with several lines of text | Lobby offers to paste them as sticky notes |

## Edit

| Key | What it does |
|---|---|
| **Ctrl+Z** | Undo (it also brings back what was selected when that step was made *(3 Oct)*) |
| **Ctrl+Shift+Z** or **Ctrl+Y** | Redo |
| **Ctrl+X** / **Ctrl+C** / **Ctrl+V** | Cut / copy / paste |
| **Ctrl+D** | Duplicate |
| **Delete** or **Backspace** | Delete (locked items stay) |
| **Ctrl+A** | Select all |
| **Ctrl+G** / **Ctrl+Shift+G** | Group / ungroup |
| **Ctrl+Shift+L** | Lock or unlock the selection (it stays selected) |
| **← ↑ → ↓** | Nudge the selection |
| **Shift + arrows** | Nudge in bigger steps *(engine default)* |
| **Ctrl+U** | Upload a file |
| **Ctrl+Shift+C** | Copy the selection as a PNG |

### Order (front and back)

| Key | What it does |
|---|---|
| **PageUp** or **]** | Bring to front |
| **PageDown** or **[** | Send to back |
| **Shift+PageUp** or **Alt+]** | Bring forward one step |
| **Shift+PageDown** or **Alt+[** | Send backward one step |
| **Ctrl+]** / **Ctrl+[** | Forward / backward one step *(engine default)* |

### Align and distribute

| Key | What it does |
|---|---|
| **Alt+A** | Align left |
| **Alt+H** | Align centres horizontally |
| **Alt+W** | Align top |
| **Alt+V** | Align centres vertically |
| **Alt+S** | Align bottom |
| **Alt+Shift+H** | Distribute horizontally |
| **Alt+Shift+V** | Distribute vertically |

Align right has no key (Alt+D belongs to the browser). Use the button in the selection bar.

## Move around and zoom

| Key | What it does |
|---|---|
| **Space + drag** | Pan |
| **Ctrl + mouse wheel**, or pinch | Zoom (a two-finger pinch on a touch screen goes down to the whole-board view) |
| **Mouse wheel**, one notch | Zoom in or out around the pointer, when Board menu ▸ Preferences ▸ **Input device** is Auto (and the wheel looks like a mouse) or Mouse; with Trackpad, or a trackpad's scroll, the wheel pans. The setting is yours alone *(3 Oct)* |
| **Ctrl+=** / **Ctrl+-** | Zoom in / out |
| **=** / **-** | Zoom in / out (when no single note is selected) |
| **Shift+=** / **Shift+-** | Zoom in / out around the mouse pointer (also with Ctrl) |
| **Ctrl+0** or **Shift+0** | Zoom to 100% |
| **Alt+1** or **Shift+1** | Zoom to fit the whole board |
| **Alt+2** or **Shift+2** | Zoom to the selection |
| **M** | Show or hide the minimap |
| **Ctrl+F** | Search the board (type **#** to search by tag) |
| **Alt+Shift+G** | Arrange the selection as a grid |

## Comments

| Key | What it does |
|---|---|
| **C** | Comment tool |
| **Shift+C** | Hide or show comment pins (for you only) |
| With the comment tool on: **Enter** | Comment on the selection (or the middle of the view) |
| With the comment tool on: **Tab** / **Shift+Tab** | Step to the next / previous object |
| With the comment tool on: **Ctrl+Shift+↓** / **Ctrl+Shift+↑** | Go inside the selected frame / back out |
| With the comment tool on: **Esc** | Close what is open, then back to Select |

## Mind maps

| Key | What it does |
|---|---|
| **Alt+Shift+M** | Start a mind map |
| **Tab** | Add a child topic |
| **Enter** | Add a sibling topic (the next one at the same level) |
| **Shift+Tab** | Move the topic up a level |
| **← ↑ → ↓** | Move between topics (when not typing) |
| **F2** or **any letter** | Edit the selected topic (a letter starts the edit and is its first word, as on a sticky note; not right after **Esc** left the topic, and not on a locked topic) *(3 Oct)* |
| **Delete** or **Backspace** | Remove the selected topics with their branches (asks first if the branch is big) |

Tab and Enter also work while you are typing in a topic: the words are saved and the new topic opens.

## Present

| Key | What it does |
|---|---|
| **Ctrl+Alt+Enter** | Start presenting |
| **→**, **↓**, **PageDown** or **Space** | Next slide |
| **←**, **↑** or **PageUp** | Previous slide |
| **Home** / **End** | First / last slide |
| **G** | Open or close the slide grid |
| **Esc** | End the presentation |

When you are following someone else's presentation, their keys drive the slides; yours only end it.

## Export

| Key | What it does |
|---|---|
| **Ctrl+P** | Export as PDF |
| **Ctrl+Shift+C** | Copy the selection (or the board) as a PNG |

The other formats are behind the download icon next to Present.

## Voting

While a vote is open and you have joined it, click a note to vote. **Tab** moves the keyboard into the
**+ / –** buttons of the selected note so that you can vote without a mouse.

## Getting around with the keyboard

| Key | What it does |
|---|---|
| **F6** | Move the keyboard onto the board (selects the first item) |
| **Alt+→** or **Alt+↓** | Select the next item, in reading order |
| **Alt+←** or **Alt+↑** | Select the previous item |
| **Ctrl+Shift+↓** | Go inside the selected frame |
| **Ctrl+Shift+↑** | Go back out to the frame |
| **Alt+R** | Say what is selected again (screen readers) |
| **Shift+F10** or the menu key | Open the right-click menu for the selection |
| **Alt+F10** | Move the keyboard to the selection toolbar (Esc returns) |
| **?**, **Ctrl+/** or **Ctrl+Alt+/** | Open the Keyboard shortcuts dialog |

## Keys that do nothing on purpose

**Ctrl+S**, **Ctrl+O**, **Alt+D** and the browser's own shortcuts (reload, new tab, address bar) are left
alone or blocked so that nothing is downloaded or opened by accident. Lobby saves on its own.

<!--
For the Lobby team. Sources at engine/excalidraw 5caee00 (2026-09-30); re-read 2026-10-03 at release/held 99ac6c52 for the files
changed since (keymap.ts: type-to-edit on a topic, the crop's Enter, viewers' Ctrl+C; mindmap/ported: type-to-edit;
navigation/zoom.ts and canvas/board/settings.ts: the wheel preference, W5-33; history/undo-selection.test.ts: F11):
  apps/web/src/canvas/input/keymap.ts (the allowlist: tool letters, undo/redo, Ctrl+A, Ctrl+F, Ctrl+0,
    Alt+1/2, F6, Alt+arrows, Ctrl+Alt+Enter, delegated engine keys, read-only roles)
  apps/web/src/features/canvas-ux/ported/{keys,commands}.ts, ShortcutsDialog.tsx, Toolbar.tsx,
    keyboard-map.test.ts (the conflict check over every feature)
  apps/web/src/features/canvas-ux/ported/navigation/index.tsx (zoom keys, M, Ctrl+F, Alt+Shift+G)
  apps/web/src/features/comments/ported/{index.tsx,keys.ts}
  apps/web/src/features/mindmap/ported/{index.tsx,keyboard.ts}
  apps/web/src/features/present-export/ported/{index.tsx,presenter.ts}
  apps/web/src/features/a11y/ported/index.tsx
  apps/web/src/features/workshops/ported/index.tsx (VOTE_TAB_KEY)
  apps/web/src/file-card/ported/index.tsx (Ctrl+U)
"Engine default" rows: plain Shift+arrow and Ctrl+[ / Ctrl+] are delegated to Excalidraw by keymap.ts;
their effect is the engine's and is not pinned by a Lobby test.
-->
