# What's new on the Lobby canvas

Lobby's boards are moving to a new drawing engine. The switch happens in the next few days, during a
short maintenance window (about 30 minutes). You will see a notice on the board while it runs, and
when it is over your boards open as usual, on the new canvas.

The new canvas is open source, so Lobby stays free to run. Most of Lobby looks and works exactly as
before. This page covers what stays the same, what is different, how to do everyday things now, and
what to do if something looks wrong.

## What stays the same

- **Your boards.** Every board, every project lobby, every note, image, file, comment and tag comes
  across. Nothing needs re-uploading or re-sharing.
- **Sharing.** Share, invite links, workshop links, client links, roles (owner, can edit, can comment,
  can view) and access requests are unchanged.
- **Guests.** Clients still join with just a name, on a phone or a laptop, and can comment.
- **Comments.** The comment tool (C), pins that stick to things, threads, replies, @mentions and the
  bell.
- **Workshops.** The timer, dot voting (with hidden ballots until the reveal), +1, reactions, raise
  hand, Gather everyone, and private brainstorming with its reveal.
- **AI.** Group into themes, summarize, action items, ideas, with the same owner switches and the same
  "Sends the selected text to OpenAI" notice.
- **Present.** Present frame by frame, and Present to everyone so people's screens follow yours.
- **Export.** PNG, SVG, PDF (one page per frame, with searchable text) and CSV, and the same export
  controls for viewers and commenters.
- **History.** Named checkpoints, Restore as new board, Recently deleted, automatic checkpoints.
- **Everything else.** Mind maps, tags, Show only, board search and search across boards, the Frames
  panel, templates and the Lobby tour, the dashboard, dark mode.

## What's different

### Text is plain text

Bold, italic and bullet lists are gone. Text on the new canvas is plain. To make a heading stand out,
make it bigger, give it a colour, or set it in the **Display** font (see Fonts below). On converted
boards, text that was bold or italic is now plain; lists keep their lines but lose the bullets.

### No more pages

Boards no longer have pages. A board that had several pages is now one board, with the old pages laid
out side by side to the right of the first one. Use **frames** to divide a board into sections instead:
the Frames panel lists them, and Present walks through them in order.

### Video and animated GIFs: a poster and a player

A video shows its poster on the board. Press the play button on the card to play it there. Animated
GIFs show their first frame until you play them.

### Links become link cards, not embedded players

Paste a web link (YouTube, Vimeo, a Google Doc, anything) and it becomes a **link card** with the
page's title and icon. Click it to open the page in a new tab. Nothing plays or loads inside the board
any more, which also means no outside script ever runs on your boards.

### Working together: what shows live, and what shows when you let go

- Other people's cursors, typing and **moves** show live, as before.
- A **resize**, a **rotation** or a **pen stroke** appears on other people's screens when the person
  finishes it, not while they are still dragging.
- You see other people's cursors, but not a highlight around what they have selected.

### Fonts

There are four fonts in the style panel: **Sans** (the default, called Nunito), **Draw** (a hand-drawn
look), **Display** (bold-looking headings, called Lilita One) and **Mono**. There is no serif font and no
separate bold. Converted text takes the closest of these; the Lobby tour and the templates use Display
for their headings.

### The look

Everything is slightly different in detail: new rectangles have rounded corners, arrowheads are a
little bigger, and sticky notes have a small hard shadow. The note colours are the same 13 DBC colours.

### Tools and menus

- The toolbar has Select, Hand, Note, Text, Rectangle, Pen, Connector and Frame, then **More** for
  the rest: Eraser, Ellipse, Triangle, Diamond, Hexagon, Rhombus, Star, Cloud, Heart, block arrows,
  Line, Highlight, Laser and Lasso select. After More come Upload, the feature tools (Comment, Mind
  map and so on) and Templates.
- The **board menu** is at the top left: Board, Edit, View, Export, Preferences. Dark mode is under
  Preferences, Theme.
- Undo and Redo buttons sit left of the tools on a wide screen. On a narrow screen they move onto the
  toolbar with Delete and Duplicate.
- Locking a frame locks everything inside it.
- You can zoom out further than before on big boards. If you zoom into empty space, a **Back to
  content** button brings the board back.

### Images: Replace media, Crop and Alternative text

Select an image and the selection bar offers **Replace media** (swap key art v1 for v2 and keep its
comments, tags, position and slot), **Crop**, and **Alternative text** for people using a screen
reader.

### On a phone

Fewer tools are shown at once so that each is big enough to tap; the rest are under More. Guests on a
phone get Select, Hand and Comment.

## How to do common things now

| I want to | Do this |
|---|---|
| Add a sticky note | Press **N** and click, or double-click empty canvas. Type straight away. |
| Edit a note | Click it and start typing, or press **Enter**. **Esc** when done. |
| Make a row of notes fast | While typing in a note, **Tab** makes the next note beside it; **Ctrl+Enter** makes one below. |
| Draw a connector | Press **L**, drag from one shape to another. It stays attached when things move. |
| Make a frame | Press **F** and drag. To rename it, select it and press **Enter**, or double-click its name. |
| Add a heading | Press **T**, type, then pick **Display** and a bigger size in the style panel. |
| Comment | Press **C** and click the thing. **Shift+C** hides or shows all comment pins. |
| Find something | **Ctrl+F** searches the board (type **#** to search by tag). |
| See the whole board | **Alt+1**. **Alt+2** zooms to what you have selected. **Ctrl+0** is 100%. |
| Upload a file or image | Drop it on the board, paste it, or press **Ctrl+U**. |
| Add a link | Paste the URL. It becomes a link card. |
| Replace, crop or describe an image | Select it, then use **Replace media**, **Crop** or **Alternative text** in the selection bar. |
| Start a mind map | The **Mind map** tool, or **Alt+Shift+M**. Type, then **Tab** for a child topic and **Enter** for the next one. |
| Lock something | Select it and press **Ctrl+Shift+L**. Unlock all is in the right-click menu. |
| Present | **Present** at the top right, or **Ctrl+Alt+Enter**. **Invite everyone** so people follow along. |
| Export | The download icon next to Present. **Ctrl+P** goes straight to the PDF. |
| Save a checkpoint | **History** in the left rail, type a name, **Save checkpoint**. |
| Dark mode | Board menu (top left), Preferences, Theme. |
| See every shortcut | Press **?**. The full list is in `docs/SHORTCUTS.md`. |

On a Mac, Ctrl is Cmd and Alt is Option.

## Your old boards

Every existing board is converted automatically during the maintenance window. You do not have to do
anything.

Two safety copies are made first:

- a full backup of every board, kept for 90 days;
- a checkpoint called **Before the move to the new canvas** in every board's History. You can open it
  with **Restore as new board** at any time. (Checkpoints saved before the switch cannot be previewed
  on the new canvas yet, but restoring them works.)

After conversion a board may look a little different: bold and italic text is plain, pages sit side by
side, embedded players are link cards, and text may wrap a little differently because the fonts have
changed. Positions, colours, comments, tags, votes and files are kept.

## If something looks wrong

**First, check the status pill** at the top of the board:

- **Saved**: everything you did has reached the server.
- **Saving…**: give it a moment.
- **Offline** or **Offline — 3 changes on this device**: the connection dropped. Your changes are kept
  on this device and sync when it comes back. If you are signed in, a reload is safe. If you joined as a
  name-only guest, do not close or reload the tab until it says Saved.
- **Change not saved**: the board refused your last change and undid it, usually because someone else
  is typing in that note or the object is locked. Hover the pill to see why.

**Rough edges we know about** (no need to report these):

- A connector attached to a note you restore from Recently deleted may not re-attach. Draw it again.
- Pressing Ctrl+Z after giving a +1 takes that +1 back for everyone.
- Name-only guests can use the board's tags but cannot create new ones.
- Enter does not finish a crop. Press Esc or click outside the image.
- On a very narrow phone the Share button can sit at the edge of the screen.
- Pinch-zooming out on a touch screen stops earlier than Alt+1 does.
- Checkpoints saved before the switch cannot be previewed (restoring them works).

**To report anything else**, send Chase, who runs Lobby, a message with:

1. the link to the board (select the thing and use **Copy link to selection** in the selection bar, and
   the link points at the exact spot);
2. what you did, what you expected, and what happened instead;
3. a screenshot if you can, and roughly when it happened;
4. your browser, or your phone model if it was on a phone.

If a board looks damaged after the switch, say so straight away and do not keep editing it: the backup
and the **Before the move to the new canvas** checkpoint hold the board exactly as it was.
