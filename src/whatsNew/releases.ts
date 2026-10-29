// src/whatsNew/releases.ts
// The "What's new" popup's pages, one entry per update that has something to
// show (updates with only small fixes need none). Each page is one change:
// a screenshot, a few plain sentences, and where to try it. Screenshots live in
// public/whats-new/<version>/ and are taken from the demo company by
// e2e/readme/whats-new.shots.ts (`npm run screenshots`). [[Key]] shows a key.

export type WhatsNewKind = 'new' | 'improved' | 'fixed';

export interface WhatsNewShot {
  /** A file in public/whats-new/<version>/. */
  file: string;
  /** There is a `-dark` version of the file, shown in dark mode. */
  dark?: boolean;
  /** A sheet of paper (a PDF page): shown whole on white rather than cropped to fit. */
  paper?: boolean;
  caption: string;
}

export interface WhatsNewPage {
  id: string;
  kind: WhatsNewKind;
  /** The part of the app it is in, e.g. "Sketch". */
  area: string;
  title: string;
  body?: string;
  /** Short points; on a 'fixed' page, the list of fixes. */
  points: string[];
  /** One picture, or two side by side (a fixes page). */
  shots: WhatsNewShot[];
  /** A button that goes there (and closes the popup). */
  action?: { label: string; to: string };
}

export interface WhatsNewRelease {
  /** The version these changes arrived in (4.7 covers everything since 4.6). */
  version: string;
  intro: { title: string; body: string };
  pages: WhatsNewPage[];
}

export const RELEASES: WhatsNewRelease[] = [
  {
    version: '4.8',
    intro: {
      title: 'Welcome to FrugalOmnibuild 4.8',
      body: 'Claude now reads your plan sheets: the sheet number and title of every page, and which sheet a revised page replaces. Two pages: what it does, and how an admin connects it.',
    },
    pages: [
      {
        id: 'claude-reads', kind: 'new', area: 'Plan sets', title: 'Claude reads your plan sheets',
        body: 'When you upload a plan set, click AI Scan on the Name Pages screen and Claude fills in each page’s sheet number and title from its title block. On a revised set it also picks the sheet each new page replaces.',
        points: [
          'Check the names, fix any it got wrong, then Finish.',
          'Draw a box with the extract tool and pick AI read to have Claude read just that box on every page.',
          'Without Claude, naming works as before, from the PDF’s text and OCR. If a read fails, it says why and the pages keep their names.',
        ],
        shots: [{ file: 'ai-scan.webp', dark: true, caption: 'A new plan set after AI Scan: every page has its sheet number and title.' }],
      },
      {
        id: 'claude-connect', kind: 'new', area: 'Settings', title: 'Connect Claude once, in Settings',
        body: 'An admin connects Claude for everyone under Settings › User Preferences › AI Sheet Reading.',
        points: [
          'For your own private install, use your Claude Pro or Max plan: run claude setup-token on any computer with Claude Code and paste the token. For anything shared more widely, paste an API key from platform.claude.com instead.',
          'Pick the model: Opus 5.5 reads small print best, Haiku 5.5 is fastest. Test connection checks it works.',
          'The token is stored encrypted and never shown again. When Claude reads a page, the page image and its text are sent to Anthropic.',
        ],
        shots: [{ file: 'connect.webp', dark: true, caption: 'Claude connected with a subscription token, tested, on Opus 5.5.' }],
        action: { label: 'Open Settings', to: '/settings' },
      },
    ],
  },
  {
    version: '4.7',
    intro: {
      title: 'Welcome to FrugalOmnibuild 4.7',
      body: 'This update brings Sketch, a 3D drawing tool for measured shapes like cornice profiles, quick measurements on plans, and a round of fixes. Here is a quick tour, about two minutes. Jump to anything below.',
    },
    pages: [
      {
        id: 'sketch', kind: 'new', area: 'Sketch', title: 'Sketch: draw it to size, then pull it into 3D',
        body: 'Sketch is a simple 3D drawing tool for measured shapes such as a cornice profile. Draw on the Front, Side or Ground plane with exact sizes, then pull a closed shape into a solid.',
        points: [
          'Open it from the sidebar, right below Document Editor, or from Documents › New › Sketch.',
          'Type sizes as you draw, in feet and inches or millimetres. Every edge shows its length.',
          'Each Save keeps a new version in Documents. Phones open sketches to look at.',
        ],
        shots: [{ file: 'sketch.webp', dark: true, caption: 'A cornice profile drawn on the Front plane and pulled into a solid.' }],
        action: { label: 'Open Sketch', to: '/tools/sketch' },
      },
      {
        id: 'sketch-exact', kind: 'new', area: 'Sketch', title: 'Put every point where it belongs',
        body: 'Snapping and typed angles make exact drawing quick.',
        points: [
          'Hold [[Shift]] to line up with what is drawn: ends, midpoints, centres, and level or plumb guides.',
          'Hold [[Ctrl]] to keep a line to 15° steps. Both have buttons in the toolbar for tablets.',
          'A typed angle is measured from level, and the line shows where it will land before you press Enter.',
          '[[Backspace]] takes back the last point.',
        ],
        shots: [{ file: 'draw-exactly.webp', dark: true, caption: 'A dashed guide lines the new point up with the corner below it.' }],
      },
      {
        id: 'sketch-faces', kind: 'new', area: 'Sketch', title: 'Draw on a solid to add to it or cut it away',
        body: 'Pick Face, then click a flat face of a solid. The view turns to look straight at it, and what you draw there belongs to that solid.',
        points: [
          'Pull a shape out to add to the solid, or in to cut a pocket, groove or hole.',
          'Perspective is a button for the 3D view. Top, Front and Side stay flat so lengths read true.',
        ],
        shots: [{ file: 'faces.webp', dark: true, caption: 'A hole being cut through a block, with a groove already cut in its face.' }],
      },
      {
        id: 'sketch-spin-run', kind: 'new', area: 'Sketch', title: 'Spin a profile, or run it along a path',
        body: 'Spin turns a profile round a line, for columns and rosettes. Run along a path sends a profile along a path, such as a cornice round a room, with mitred corners.',
        points: [
          'The Steps list shows each pull, spin and run in order.',
          'Pick a step to see it on the model, change its distance or angle, or delete it.',
        ],
        shots: [{ file: 'spin-run.webp', dark: true, caption: 'A stepped cornice run round three sides of a room.' }],
      },
      {
        id: 'sketch-solids', kind: 'new', area: 'Sketch', title: 'Join, cut, move, copy, rotate and mirror',
        body: 'Work with whole solids: join two together, cut one from another, move or turn them, and make copies in a row or round a point.',
        points: [
          'Join/Cut ([[J]]), Move ([[M]]), Rotate ([[T]]) and Mirror ([[I]]) are in the toolbar.',
          'Set Copies to keep the original and make that many copies, each one step further on.',
          'You see where it will land before you click.',
        ],
        shots: [{ file: 'solids.webp', dark: true, caption: 'Two blocks joined, copied along in a row, then mirrored.' }],
      },
      {
        id: 'sketch-photos', kind: 'new', area: 'Sketch', title: 'Trace over a photo or a print',
        body: 'Lay a photo, scan or PDF print on the plane you are drawing on, and trace over it.',
        points: [
          'Use the picture button in the toolbar. Upload a file, or pick one already in Documents.',
          'Set scale: click the two ends of a length you know, then type how long it really is.',
          'Fade, turn, move or hide it from the Reference photos list.',
        ],
        shots: [{ file: 'photos.webp', dark: true, caption: 'A section print scaled from its 12-inch dimension, ready to trace.' }],
      },
      {
        id: 'sketch-round', kind: 'new', area: 'Sketch', title: 'Round and bevel edges',
        body: 'Round or bevel edges ([[E]]) softens corners. Click the edges, or click a face for all the edges round it, then type the size.',
        points: [
          'The solid shows the result as you type. Enter makes it a step.',
          'A size too big for the edges is caught with a message before it is made.',
          'Change the size later in the Steps list.',
        ],
        shots: [{ file: 'round.webp', dark: true, caption: 'Two edges picked with a ½" radius typed: the rounding shows before Enter.' }],
      },
      {
        id: 'sketch-export', kind: 'new', area: 'Sketch', title: 'Export drawing sheets, pictures and CAD files',
        body: 'Export makes a drawing sheet (PDF): Front, Top and Right side to scale with dimensions, a 3D view, and your title block.',
        points: [
          'Picture (PNG) saves the view as it is on screen, up to three times bigger.',
          'CAD file (DXF) gives a profile at true size for CAD or a CNC cutter, with exact arcs and circles.',
          'Download it, or save it to Documents as a Sketch Export.',
        ],
        shots: [{ file: 'export.webp', paper: true, caption: 'A drawing sheet of a cornice profile: each view at the largest scale that fits it.' }],
      },
      {
        id: 'sketch-ipad', kind: 'new', area: 'Sketch', title: 'Drawing on an iPad with the Apple Pencil',
        body: 'Press, slide to aim, and lift to place a point. The length shows above your fingertip as you slide.',
        points: [
          'Once you use the Pencil it does the drawing and fingers move the view, so a resting hand cannot add points.',
          'Double-tap ends a line. Tap with two fingers to undo, three to redo.',
          'Back, Done and Cancel appear while drawing, for when there is no keyboard.',
        ],
        shots: [{ file: 'ipad.webp', dark: true, caption: 'Aiming the next line with a finger, the length shown above it.' }],
      },
      {
        id: 'quick-measure', kind: 'new', area: 'Takeoff canvas', title: 'Quick measurements',
        body: 'Measure a length or an area on a plan without picking a takeoff. Press Measure in the toolbar.',
        points: [
          'They are drawn dash-dot in magenta, and are never priced or counted in totals.',
          'Everyone on the plan sees them. Hide them with the eye button in the sidebar.',
          'Pick "Move to takeoff" to turn one into a priced measurement.',
        ],
        shots: [{ file: 'quick.webp', dark: true, caption: 'Lengths and an area listed under Quick measurements (not priced).' }],
      },
      {
        id: 'feet-inches', kind: 'improved', area: 'Takeoff canvas', title: 'Lengths in feet and inches',
        body: 'Lengths on the plan now read in feet and inches to the nearest 1/32", such as 30\' - 6 1/2".',
        points: [
          'Labels run along their line and never read upside down.',
          'Totals, exports and prices still use the exact value.',
        ],
        shots: [{ file: 'labels.webp', dark: true, caption: 'Labels along sloped and upright lines, in feet and inches.' }],
      },
      {
        id: 'fixes', kind: 'fixed', area: 'All over the app', title: 'Fixes and smaller changes',
        points: [
          'Photos in generated PDFs (proposals, daily reports, RFIs, issues, invoices, change orders) come out the right way up and keep their shape.',
          'Number boxes such as Advanced Costing no longer put a 0 back when you clear them.',
          'In dark mode, typed text is no longer black on a dark box, and Project Notes stays white like paper.',
          'Save to Documents and Upload: each file\'s Type sits beside its name, and the type is guessed for you.',
          'Saving a new version of a file now checks that you may see that file.',
          'Dialog buttons and the bottom of the sidebar no longer sit flush against the bottom edge of the screen.',
        ],
        shots: [
          { file: 'fix-photos.webp', paper: true, caption: 'Photos upright, not stretched' },
          { file: 'fix-upload.webp', dark: true, caption: 'Each file\'s type beside its name' },
        ],
      },
    ],
  },
];
