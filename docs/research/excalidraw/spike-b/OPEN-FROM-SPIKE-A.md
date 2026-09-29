# Open defects carried from spike A into spike B

Spike A's guard code (`apps/web/src/canvas/input/**`, `apps/web/src/canvas/lease/**`) went through two fix rounds. After fix round 2 (merged as B0), two independent verifiers found the defects below. Their verdicts: no way was found to type into a note without a lease, and nothing downloads, opens a picker or dialog, or replaces the scene on any real layout tested. But two text-loss paths and several key leaks remain.

These are **O2's first tasks in spike B** (O2 owns `canvas/input` and `canvas/lease` from B0). Each needs a regression test that fails before the fix and passes after. V1 (room, lease, undo) and V2 (security, including keys) re-check every item. Probes live in the verifiers' worktrees, which are uncommitted: `Draftroom-spike-vl/e2e/spike/verifyL/` and `Draftroom-spike-vk/`.

## Lease and editor-open verifier: FAIL

### L1 (high)

When the guard's editor closes before a grant, it writes back an old copy of the text and undoes the holder's typing. On P5, or a double-click on a note's words, Excalidraw opens the textarea before the grant. Its value is copied once from the label (index.js:25247) and never refreshed. If the lease holder's typing arrives while our request is out, every way out of the pending editor lets Excalidraw submit that old copy: the deny (onOutcome editorLease.ts:574-576 -> closeTextarea -> synthetic Escape -> handleSubmit 25482-25526), Escape (cancel() 345-352), and click-away or blur (CanvasInput.onBlur 529-534 only steps in when mustNotSubmit, and mustNotSubmit 226-231 only checks for a deleted or unbound label). The holder's text reverts on our client. That is a local write, with a version bump, to a label whose lease another session holds. This happens on the most common open path, a double-click on a note someone else is typing in.

**Repro.** Page /spike/host-lab?grant=150. Add note A with text 'memo' and call lease.holdByOther(A), so Alice is typing. Double-click A's label (or do P5): the guard is read-only with value 'memo' and the acquire is out. 40 ms later, apply Alice's keystroke as a remote updateScene: label text 'memo by alice', captureUpdate NEVER. At 150 ms the deny arrives (toast 'Alice is typing in this note'), and A's label becomes 'memo' again while the server still names Alice. The same happens if the user presses Escape or clicks away before the answer (grant=manual). Results: E6 deny 20/20, Escape 20/20, click-away 20/20; L4 guard-pending 20/20. The random fuzz L6 found it on its own in 2 of 20 seeds ('cleft.'->'cleft' while Alice held F3; 'memo.'->'memo'). My independent 4 ms watcher logged each case as unleased-text-write (server holder Alice). Probes: C:/Users/Chase/Documents/GitHub/Draftroom-spike-vl/e2e/spike/verifyL/extra.probe.ts (E6) and lease.probe.ts (L4, L6).

### L2 (high)

Same root cause, grant side: the old copy becomes writable and overwrites the previous holder's last edits. finishOpen (editorLease.ts:765-791) turns the guard's textarea writable without comparing its value with the label. Excalidraw's oninput (25356-25364) writes the whole textarea value on every keystroke. So edits by the previous holder that arrived between our P5/P3 click and our grant (for example her last keystrokes just before she released) are lost at our first keystroke. The A16 note 'A newer remote text for the label is never overwritten by the stale textarea' covers only the lost-lease path. P1, which opens only after the grant, is not affected.

**Repro.** Page /spike/host-lab?grant=manual. Add note A with text 'memo' and call holdByOther(A). Do P5 on A (or double-click its label): guard, read-only, value 'memo'. Apply a remote label change to 'memo by alice', then clearOther(A) (Alice has released). Flush: the grant arrives, and the textarea is writable with 'memo'. Press End and type '!': the label is stored as 'memo!' and Alice's text is gone. Results: L3-P5 20/20, L3-P3 20/20. With a timed server (E5: grant=150; Alice's edit at +40 ms and her release at +60 ms after our click) 20/20. Control, P1 with the same race: 20/20 stored 'memo by alice!'. My watcher cannot flag this one because the write is made under our lease; the probe checks the stored text instead. Probes: lease.probe.ts (L3), extra.probe.ts (E5).

### L3 (low)

denyNew (editorLease.ts:613-635) has the same class of problem. On a deny for a New-element open, it sets ta.value back to the value the editor opened with and runs Excalidraw's submit. If the holder edited the label meanwhile, their text is overwritten locally (an empty opened value deletes the label). In practice this needs another session to hold a just-created id before the creator's acquire arrives, which is hard to reach.

**Repro.** Page /spike/host-lab?grant=manual. Place a note with the N tool: origin 'new', writable before the grant, which the rule allows. Type 'XY', then holdByOther(note): the editor becomes read-only, which is correct. Apply a remote label change to 'alice was here', then flush: the deny comes back and denyNew submits '', so the label is emptied and deleted while Alice holds the lease. L4 new-provisional: 20/20.

### L4 (low)

Keys typed into the guard's pending editor are dropped with no notice when that editor is left before the answer by a click away or a blur. The selection-change cancel says 'what you typed was discarded' and offers the text; this path says nothing. By code reading, giveUp('no-editor' / 'no-focus' / 'no-container') (editorLease.ts:793-807) also drops the buffer without a notice; I did not reproduce that.

**Repro.** Page /spike/host-lab?grant=manual. Do P5 on A (guard pending), type 'QS', then click on empty canvas or blur the textarea. The stored text stays 'memo', there are 0 notices, and 'QS' is gone. E4: 10/10 for click-away plus blur. Escape, which is an explicit cancel, and grant-then-click-away (stored 'meQSmo') behave as expected.

## Keys and keyboard-layout verifier: FAIL

### K1 (medium)

Keys typed outside the board still write the canvas. Excalidraw's onKeyUp listens on the document (index.js 49349, handler 44237). Lobby only stops keyups for keydowns that crossed the board wrapper, so a keyup from any other input on the page, or from the body, reaches Excalidraw. On an arrow keyup it re-binds every selected bound arrow (mutateElement startBinding/endBinding, 44300-44338). mutateElement always treats object values as changed, so each keyup bumps the arrow's version: a real write the sync adapter would push, from arrow keys that never touched the board. A Space keyup there also clears the selection while one of Lobby's custom tools is active. A smaller gap in the same class: a blocked keydown with an empty `code` never gets its keyup stopped, because blockedKeyups is keyed by code (CanvasInput.ts:300 and :324). The sweep saw this 16 times per context, only with key 'Unidentified'. Read-only roles are not affected (onKeyUp returns while interaction is off).

**Repro.** /spike/host-lab?grant=0, editor role. Add rectangles r1 and r2 and an arrow a1 bound r1 to r2 (fixture.bindArrow), select only a1. Append an <input> to document.body (outside the board wrapper) and focus it. Send CDP Input.dispatchKeyEvent rawKeyDown and keyUp for ArrowLeft, ArrowRight and Shift+ArrowUp. Result: a1 goes from version 4 to 10, with 6 mutateElement calls (startBinding, endBinding) and no Lobby key trace. With focus on the body: version 22 to 28 with identical binding values, so these are pure version bumps. Same with the note tool active and r1 selected: Space in the input clears the selection ['r1'] to []. 3/3 on Windows and 3/3 under macOS emulation. Probe: e2e/spike/verifyK/targeted.probe.ts ('keyup reaching Excalidraw from outside'); data in scratchpad vk/targeted-keyup-{win,mac}.json.

### K2 (low)

Inside the granted text editor, Ctrl+Insert typed on the numpad with NumLock off resets the canvas zoom. Chromium reports that key as key 'Insert' with code 'Numpad0'. Lobby keeps Ctrl+Insert by key as the copy chord (keymap.ts:482), but the textarea's own handler tests the code: its `!shift && actionResetZoom.keyTest` (index.js 25376, keyTest 9686: code Digit0 or Numpad0, plus CTRL_OR_CMD) runs executeAction(actionResetZoom). This contradicts A6.md's claim that 'no delegated key triggers a textarea action except Escape and Tab', and the fixer's statement that zoom is blocked inside the editor. Viewport only; no element change.

**Repro.** /spike/host-lab?grant=0. Add note n1, set zoom to 1.7 with updateScene, then requestEdit('n1'), which opens the editor granted. Send CDP rawKeyDown and keyUp {code:'Numpad0', key:'Insert', windowsVirtualKeyCode:45, location:3, modifiers:2} (4 = Cmd under macOS emulation). Lobby's verdict is 'delegate', the action hook records resetZoom, and the zoom goes from 1.7 to 1. 3/3 on Windows and 3/3 under macOS emulation. Control: the real Insert key (code 'Insert') performs no action. The full sweep flags the same event: 'actions from inside the text editor: resetZoom'. This is emulated through CDP; no NumLock-off numpad was physically used. Probe: verifyK/zoom.probe.ts.

### K3 (low)

On BÉPO and KOY, Ctrl/Cmd+Z inside the granted editor outdents the line instead of undoing. Both layouts put 'z' on the physical BracketLeft key. Lobby keeps the chord because it reads the letter from `key` (chordLetter 'z', undo). Excalidraw's textarea handler matches `CTRL_OR_CMD && code === BracketLeft` (index.js 25399) and outdents, then prevents the default, so the native undo never runs. It removes up to 4 leading spaces of the line and writes them to the leased label. Ctrl/Cmd+Shift+Z (redo) takes the same path. The edit stays inside the user's own leased label, but the user did not ask for it, and it contradicts the fixer's 'none of the kept chords matches any key test of the textarea's handler'.

**Repro.** /spike/host-lab?grant=0. Note n1 with text '    Note one'. Open the editor granted and type 'X' with execCommand insertText. Send CDP {code:'BracketLeft', key:'z', vk:90, modifiers:2} (4 under macOS emulation). The textarea goes from '    Note oneX' to 'Note oneX': outdented, and the 'X' is not undone. Control, QWERTY {code:'KeyZ', key:'z'}: '    Note oneX' becomes '    Note one' (native undo). 3/3 each on Windows and under emulation. The full sweep flags FR-BEPO Ctrl+z and Ctrl+Shift+Z on BracketLeft ('untrusted input on z/BracketLeft') on both platforms. Probe: verifyK/targeted.probe.ts; layout table verifyK/layoutsK.ts.

### K4 (low)

Inside the editor, chordLetter also reads the physical key for named keys. When `key` is not a Latin letter it uses the letter of `code` (keymap.ts:219-223), and that includes 'Enter', 'Escape' and 'Tab'. A navigation key sent from a letter key is therefore treated as a kept letter chord. On Neo 2 layer 4 on Linux (xkb), Mod4+V gives Enter on code KeyV, so Ctrl+that key is kept as Ctrl+V and Excalidraw's Ctrl+Enter submit runs (index.js 25392). The fixer documents Ctrl+Enter as blocked. Ctrl+Escape on KeyZ (kept as z) and Ctrl+Tab on KeyX (kept as x) go through the same way. Each effect equals plain Escape or Tab (submit or indent), so there is no data risk; only the documented allowlist is inaccurate.

**Repro.** Granted editor on n1, then CDP {code:'KeyV', key:'Enter', vk:13, modifiers:2}. Lobby's verdict is 'delegate', editingTextElement becomes null and the editor is submitted. Win and mac-emulated full sweeps: 'Meta+Enter/KeyV' and 'Ctrl+Enter/KeyV'. Emulated; Neo layer 4 was not installed.

### K5 (low)

Several rules decide by `key` alone while Excalidraw tests `code`: modifier keys, arrows, Escape, Delete/Backspace and Space outside the editor, and the kept chords inside it. If key and code disagree, Excalidraw runs code-based actions Lobby never meant to delegate:
- Outside the editor: copyAsPng (a clipboard.write of the board as PNG), copy, copyStyles (toast), flip and distribute; Arrow+Shift on code KeyH/KeyV flips elements, and on Equal/Digit0-3 it zooms or fits.
- Inside the editor: zoom (a modifier or caret key on Equal/Minus/Digit0 with Ctrl) and font size (key '<' ',' '.' '>' on code KeyZ/KeyV with Ctrl+Shift sets currentItemFontSize).
- Read-only roles: resetZoom and zoomToFit.
No layout in my table produces these pairs. That includes Neo layer 4 on Linux, which does put arrows, Backspace, Delete, Escape and Tab on letter codes, and nothing breaks there. They are reachable only with synthetic events or an unusual remap that gives a letter keycode a modifier keysym (xmodmap-style; not verified on a real system).

**Repro.** Crafted sweep (VK_CRAFTED=1, 2,584 events per context). Outside, win: CDP {key:'Shift', code:'KeyC', modifiers:9 (Alt+Shift)} → Lobby 'delegate' (MODIFIER_KEYS early return, keymap.ts:556) → action copyAsPng + clip-write. {key:'ArrowUp', code:'KeyH', modifiers:8} → flipHorizontal. Editor: {key:'<', code:'KeyV', modifiers:10} → decreaseFontSize. Read-only: {key:'Shift', code:'Digit0', modifiers:8} → resetZoom. Data in scratchpad vk/probe/*-crafted.json.

