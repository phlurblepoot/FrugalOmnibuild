import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { Globe, Image as ImageIcon, Users, History, User, Palette, Sun, Moon, Check, Zap, ZapOff, Save, Link, Mail, Trash2, RefreshCw, CheckCircle, HardDrive, Sparkles, FileSpreadsheet, Lock, Loader2, Layout, Tag, Plus, Pencil, X, Sunrise, Layers, DatabaseBackup, FileText, FilePlus2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getSettings, saveSettings, getStorageStats, formatBytes, StorageStats, getStorageOrphans, cleanupStorageOrphans, saveBinaryFile, getAuthHeaders, getDocumentTypes, saveDocumentTypes, getDocuments, CustomDocType, getDefaultProjectTab, setDefaultProjectTab } from '../utils/store';
import { PROJECT_SECTIONS } from './project/ProjectTabBar';
import { UsersView } from './UsersView';
import { MailAccountsTab } from './settings/MailAccountsTab';
import { BackupTab } from './settings/BackupTab';
import { DocumentEditorTab } from './settings/DocumentEditorTab';
import { DocumentTemplatesTab } from './settings/DocumentTemplatesTab';
import { MySignatures } from './settings/MySignatures';
import { PhoneNotifications } from './settings/PhoneNotifications';
import { TemplatesView } from './TemplatesView';
import { useTheme, AccentKey } from '../context/ThemeContext';
import { getAiStatus, aiAutoNameEnabled, setAiAutoNameEnabled, type AiStatus } from '../utils/aiSheets';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { Field, Input, NumberInput } from '../components/ui';

// ── Changelog data ────────────────────────────────────────────────────────────

interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '4.6.0',
    date: 'October 18, 2026',
    changes: [
      'Change: the app is now called FrugalOmnibuild, since it does far more than takeoffs. A new install starts with that name; an existing install keeps the app name already saved in Settings. The Google Drive backup folder is now "FrugalOmnibuild Backups" for new installs, and installs that already have a "Frugal Takeoff Backups" folder keep using it.',
      'Change: the built-in letterhead template (docs/Template.docx) is now a generic placeholder with "Your Company Name", so replace it with your own letterhead under Settings > Document Templates.',
    ],
  },
  {
    version: '4.5.1',
    date: 'October 16, 2026',
    changes: [
      'Fix: sharing a file to the app while signed out now brings you back to the share page with your files after you sign in, instead of the dashboard.',
      'Change: the owner name on a new lien release now starts as the project name.',
      'Change: lien release PDFs no longer print the reference line under the letterhead, and the signature and notary blocks fit on the first page.',
    ],
  },
  {
    version: '4.5.0',
    date: 'October 15, 2026',
    changes: [
      'Change: forms and dialogs no longer close when you click outside them, so a stray click cannot throw away what you were typing. Photo viewers and menus still close on an outside click.',
      'New: forms that track unsaved changes (billing documents, daily reports, issues, punch items, RFIs and tasks) ask "Discard changes?" before closing from the X, Esc or the Close button.',
    ],
  },
  {
    version: '4.4.0',
    date: 'October 15, 2026',
    changes: [
      'New: Florida lien releases. From a pay application, invoice or payment, or from Documents > New, create a waiver and release of lien that follows the Florida statute wording (progress or final, conditional or unconditional). Each release has its own number (LR-1, LR-2), keeps its own copy of the lienor details, and can be saved as a PDF, sent by email or signed with your saved signature.',
      'New: Settings > Company legal details. Enter your legal name, entity type and state of formation once and they fill in every new lien release, including the notary sentence. Each release can still be edited on its own.',
      'New: starting a lien release warns you before generating if the amount is more than what has been paid, since an unconditional waiver should only follow payment you have received.',
    ],
  },
  {
    version: '4.3.0',
    date: 'October 15, 2026',
    changes: [
      'New: email drafts keep their attachments. Files you attach while writing are saved with the draft, and a draft can carry up to 25 MB in total, the same limit Gmail uses.',
      'New: open a draft from the Drafts folder to keep writing it. Click it and the composer opens with the recipients, subject, text and attachments in place. Discard deletes the draft; closing the window keeps it.',
      'Fix: sending a draft now removes it from the Drafts list straight away instead of at the next sync.',
    ],
  },
  {
    version: '4.2.0',
    date: 'October 15, 2026',
    changes: [
      'New: merge PDFs. Select two or more PDFs on the Documents page and choose "Merge PDFs". A window lists them in order, you can drag them (or use the arrows) to reorder, name the result, and pick the project if they come from different projects.',
      'New: add pages from one PDF into another. Choose which pages (blank means all, or something like "1-3, 5") and where they go.',
      'New: favorite projects. Tap the star on a project in the list or beside its name at the top of the project. The Projects page has a Recent / Favorites switch, and it remembers your choice.',
      'New: Settings > Preferences > Projects lets you pick which tab a project opens on. Clicking the Overview tab itself still works.',
      'New: share into the app from your phone. On Android, Share a PDF, photo or document and choose this app. Pick a project and a document type (a sensible one is chosen for you) and it is filed. If you are signed out you sign in first and your files are waiting.',
      'New: the first time a PDF opens in the editor, a small tip explains how to type on a form that has no box: click Edit PDF, then Insert, then Text Box. You can dismiss it and it will not come back.',
      'Fix: a number box holding 0 now shows empty with the faded 0, so typing 5 gives 5 instead of 05. Boxes whose faded text means something else (for example "base 10%") still show a real 0.',
    ],
  },
  {
    version: '4.1.14',
    date: 'October 15, 2026',
    changes: [
      'Number boxes are friendlier everywhere. An empty box shows a faded 0 instead of a real 0 you have to delete first, clearing a box no longer writes a 0 behind your back, and if you click away from a box left empty it goes back to its previous value. Boxes where empty is a real answer (for example a cleared retainage or an optional amount) still stay empty. This covers invoices, change orders, pay applications, the schedule of values, payments, proposals, daily reports, takeoff, canvas, backup and email settings.',
    ],
  },
  {
    version: '4.1.13',
    date: 'October 15, 2026',
    changes: [
      'Pop-up windows no longer close when you click outside them, so a stray click can\'t throw away what you typed. Esc, the X and Cancel still close them. Windows with a form can ask "Discard changes?" before closing when something was edited.',
    ],
  },
  {
    version: '4.1.12',
    date: 'October 15, 2026',
    changes: [
      'Fix: "Load images" on an email now actually shows the pictures. The message frame was blocking them even after you asked to load them.',
      'New: when images are blocked, a new button, "Always load from <sender>", turns on images for every email from that sender. It is saved to your own account, so it doesn\'t change what anyone else sees. A small "Stop loading" button next to it turns it back off.',
    ],
  },
  {
    version: '4.1.11',
    date: 'October 15, 2026',
    changes: [
      'A project\'s Documents tab now stays inside the project. Before, opening it jumped to the main Documents page and the project\'s top bar and tabs disappeared. Now the project header and tabs stay put and the list shows only that project\'s documents, with the same search, filters, upload and actions as before. The project and Unassigned filters are hidden there since the project is already chosen. The main Documents page works as it did, and links to a project\'s documents (the command palette, takeoff prints) go to the project\'s tab.',
    ],
  },
  {
    version: '4.1.10',
    date: 'October 7, 2026',
    changes: [
      'A project that has anything in it can no longer be deleted, only archived. That means documents, plan pages, measurements, proposals, invoices, payments, change orders, pay applications, RFIs, issues, punch items, daily reports, time, notes or linked emails. Only a project with nothing in it, such as one made by mistake, can still be deleted. Who can delete is unchanged.',
      'Clicking the trash can on the Projects page now checks the project first. If it has anything in it, the box says what (for example "Has 12 documents and 2 invoices — archive it instead.") and offers Archive in place of Delete. An empty project deletes as before: type "delete" to confirm. The same goes for Delete in a project\'s Settings: the reason shows under it, with Archive just above.',
      'An archived project keeps everything and can be restored anytime from the Archive tab.',
    ],
  },
  {
    version: '4.1.9',
    date: 'October 7, 2026',
    changes: [
      'Security: photos, PDFs and other files can no longer be opened by anyone who has (or guesses) their link without signing in. Every photo, plan page, PDF and download now needs a signed-in account, the same as the rest of the app. Your browser keeps a sign-in cookie just for loading pictures and files, set when you sign in and removed when you click Logout. If you were already signed in before this update it is set for you as the app opens, so nothing shows broken and you don\'t need to sign in again.',
      'Security: admin-only files stay admin-only through their links too. Invoices, pay applications, change orders, proposals and payment photos and PDFs (check images) already didn\'t show to anyone but an admin in the app; opening one by its link now answers "not found" for anyone else. A signature still opens only for the person it belongs to.',
      'Security: photos and files are no longer marked as shareable for Cloudflare or any other shared cache to keep. Only your own browser keeps a copy. Share links you send to people without an account work as before.',
      'Security: an uploaded or emailed file can no longer run code inside the app. Opening an SVG drawing, a web page (.html) or any other file that isn\'t a photo, PDF, audio or video straight from its link — an upload, a shared file, or a mail attachment — now shows it with scripts turned off, so a booby-trapped file can\'t act as you. Photos and PDFs open exactly as before.',
      'Note for self-hosters: no settings to change and no database migration. Behind Cloudflare the new sign-in cookie is marked secure automatically. If you use a different reverse proxy, make sure it sends X-Forwarded-Proto along with X-Forwarded-For. If you set Cloudflare to cache everything, including /api, purge its cache once after updating so no copy cached under the old setting is served.',
    ],
  },
  {
    version: '4.1.8',
    date: 'October 6, 2026',
    changes: [
      'Fix: billing dates no longer show a day early. In US time zones a date picked as October 1 on an invoice, change order or payment showed as September 30 — on the Payments tab, in the invoice and pay application editors\' payment lists, on the Change Orders tab, on invoice and change order PDFs, on a customer\'s Billing tab and Payments and Needs attention cards, and on the dashboard\'s Recent payments card. Pay application "Period to" and "Application date" showed a day early on the Applications list too. Every one of them now shows the day that was picked, and opening an editor never moves its date. Nothing stored changes, so dates already entered are fixed as well.',
      'Recording a payment now fills in today\'s date for you (change it if the payment came in on another day), and a new pay application starts on today\'s date on your own calendar — late in the evening it used to start on tomorrow\'s.',
    ],
  },
  {
    version: '4.1.7',
    date: 'October 6, 2026',
    changes: [
      'Fix: older change orders — made before change orders had line items — no longer show $0. Their amount showed as $0 on the Change Orders tab, in the editor, on the PDF and on the project dashboard\'s Change orders card, and clicking Save in the editor changed the amount to $0, which took an approved one out of the contract total. They now show their real amount as the lump sum, and saving one keeps it. A PDF already made for one of them (which printed $0) now shows as out of date — regenerate it.',
      'Note for self-hosters: this update includes a small data-transforming migration (47) that copies the amount of each change order with no line items and no lump sum into its lump sum (the amount itself is unchanged) — back up before pulling this update.',
    ],
  },
  {
    version: '4.1.6',
    date: 'October 6, 2026',
    changes: [
      'New Reports page (admins only), in the sidebar and the command palette: billing reports across all your projects, filtered by customer and project. Archived projects are included — money owed on a closed-out job is still owed — and unticking "Include archived projects" leaves them out. Download Excel saves the report exactly as filtered; the spreadsheet\'s filter buttons sort it further.',
      'Open invoices: every sent invoice and finalized pay application that still has a balance, whatever its status says, with its customer, project, date, days outstanding (counted from the invoice or application date) and the dashboard\'s aging buckets (0–30, 31–60 and 61+ days) — oldest first, with totals and a subtotal per bucket. With archived projects left out, the totals match the dashboard\'s Outstanding and Aging receivables.',
      'Payments received: the payments in a date range — this month to start with, or last month, this quarter, year to date, last year, all time or any dates you pick — with each one\'s date, customer, project, what it paid, method, note and amount, and the total. Payment photos and PDFs are not part of it; they stay on the payment.',
      'Change orders: every change order by project with its number, title, status, date, amount and schedule impact, and a total for each status. Click a status — Sent is "waiting on approval" — or pick one to see only those. Older change orders marked Pending count as drafts.',
      'Retainage: for each project with a finalized pay application, the latest one\'s contract sum to date, work completed and stored to date, and the retainage held and released so far, worked out the same way as its G702.',
      'Invoices are now marked Paid by themselves once their payments cover the total, and go back to Sent if a balance opens up again — a payment is deleted or lowered, or the invoice\'s lines grow. A draft invoice that is paid in full is marked Paid too. Clicking the status still changes it by hand; a status set by hand stays until the next payment or line change. Anyone with the invoice open elsewhere sees the change.',
      'Invoices you already have that are paid in full but still say Sent are marked Paid when you update.',
      'Note for self-hosters: this update includes a small data-transforming migration (46) that marks sent invoices whose payments already cover their total as paid (only the status changes) — back up before pulling this update.',
    ],
  },
  {
    version: '4.1.5',
    date: 'October 6, 2026',
    changes: [
      'A length or area measurement can now count more than once — for example one floor plan that is the same for four floors. Select the measurement in the canvas sidebar and click Multiplier (next to Rename), then enter how many times it counts: a whole number from 1 to 999, where 1 counts it once. The row gets a ×4 badge next to its name.',
      'Everywhere one measurement\'s amount is shown, a multiplied measurement shows the math, e.g. "1250.00 sq ft × 4 = 5000.00 sq ft": its label on the canvas and on printed plans, its row in the canvas sidebar (cutouts too), the selected-measurement bar and segment label at the bottom of the canvas, and its row on the Takeoffs tab.',
      'Every total uses the multiplied amount: the sidebar and Takeoffs tab totals, page totals, the legend on the canvas and on printouts, dollars, the Excel export, proposals and the Schedule of Values seeded from the estimate. In Excel a multiplied measurement\'s row also shows its Measured Qty and Multiplier in two extra columns.',
      'Count markers don\'t have a multiplier. Merging measurements that have different multipliers isn\'t allowed — give them the same multiplier first. Like other edits, a multiplier can be undone, and it carries over to a new revision of the sheet; it can\'t be changed on an older (read-only) revision.',
    ],
  },
  {
    version: '4.1.4',
    date: 'October 6, 2026',
    changes: [
      'Daily reports now have crews. Each project\'s Daily Reports page has a tab for each crew — your own crew or a sub\'s — and every crew keeps its own full set of daily reports with its own calendar: one report per day per crew, each with its own date, start time, weather, man count, notes, issues, photos and PDFs.',
      'Add crew (next to the tabs) adds a crew under the name you type, and opens its tab. The ⋯ button next to it renames the open crew or deletes it — only a crew with no reports can be deleted, and a project always keeps at least one crew. Your tab is kept in the page address, so a link or a refresh opens the same crew.',
      'A new report starts at the same time as that crew\'s last report, so a crew on nights and a crew on days each keep their own start time.',
      'The All crews tab shows every crew\'s reports on one calendar (or list): each day lists each crew\'s report with its crew name and man count. It is for viewing — click a report to open it; new reports are added on a crew\'s tab.',
      'Since one day can now have a report from several crews, a report is named with its crew everywhere it is named by its date: the report\'s title, the PDF (in its heading, a new Crew line, and its file name, e.g. DailyReport-Dunmore-Heights-Crew-1-2026-10-06.pdf), the email subject, Documents (which now opens the report\'s crew tab), mail links, the activity feed and the dashboard\'s Latest daily report card. In the list view the men-on-site column is now called "Men".',
      'Your existing daily reports are now in a crew called "Crew 1" on each project — rename it to whatever you call that crew. Renaming a crew marks its reports\' PDFs out of date, since the crew\'s name is printed on them.',
      'Note for self-hosters: this update includes a data-transforming migration (45) that rebuilds the daily reports table to give each report a crew, and moves every project\'s existing reports into a new "Crew 1" (report ids, photos and PDF attachments are unchanged) — back up before pulling this update.',
    ],
  },
  {
    version: '4.1.3',
    date: 'October 6, 2026',
    changes: [
      'Daily reports now have a start time, next to the date (and on the PDF under the date). The weather covers the start time through 12 hours later — a 7:00 AM start shows 7 AM to 7 PM. A start after noon runs past midnight, and the next morning\'s hours are marked "+1", e.g. "2 AM +1".',
      'A new daily report starts at the same time as the report before it, so you rarely need to change it; the first report on a project starts at 6:00 AM, which gives the same 6 AM–6 PM weather as before.',
      'Changing the start time on a report that already has weather asks "Update the weather to match the new start time?" — Update weather fetches it again for the new hours, Keep current leaves it as it is. Fetch weather and Refresh weather always use the start time in the form.',
      'The start time also shows in the Daily Reports list and on the project dashboard\'s Latest daily report card. Reports made before this update have no start time, and their weather (6 AM–6 PM) is unchanged.',
      'Note for self-hosters: this update adds one new column to the daily reports table (migration 44, additive — existing data untouched).',
    ],
  },
  {
    version: '4.1.2',
    date: 'October 6, 2026',
    changes: [
      'Payments can now have photos and PDFs attached — a photo of the check, a receipt, remittance advice or an ACH confirmation. Add them while recording a payment with Attach under the form (or drag them onto it; on a phone, Attach can take a photo), and they are saved with the payment when you click Record.',
      'Click a payment on Billing → Payments to open it: change its date, amount, method or note, delete it, and see its attachments — photos open full size, PDFs open in the viewer — and add more or remove them. A paperclip on the row shows how many it has.',
      'Attachments stay on the payment: they do not appear in the invoice\'s payment list, on invoice or pay application PDFs or emails, or in reports. Like the rest of billing, only admins can see them (in Documents they are listed as "Payment Attachment", for admins only).',
      'Changing a payment\'s amount marks its invoice\'s or pay application\'s PDF out of date, since Paid and Balance change; changing only the date, method or note does not.',
      'Note for self-hosters: this update adds one new database table for the attachments (migration 43, additive — existing data untouched).',
    ],
  },
  {
    version: '4.1.1',
    date: 'October 6, 2026',
    changes: [
      'Change orders, RFIs, issues and daily reports can now have PDF attachments, the same way invoices do: Add PDFs in the editor uploads a PDF or picks one already in the app (from any project), and the list can be reordered or trimmed. The attached PDFs\' pages are added to the end of the generated document — after its own pages and photos — in the order shown, so they go out with the email too.',
      'Adding, removing or reordering an attachment marks that document out of date, so the next Generate or Send includes the change.',
      'On an RFI these are separate from the GC\'s answer, which stays under Response.',
      'Note for self-hosters: this update adds four new database tables for the attachments (migration 42, additive — existing data untouched).',
    ],
  },
  {
    version: '4.1.0',
    date: 'October 6, 2026',
    changes: [
      'Canvas: clicking one segment of a measurement now shows what that segment alone is worth — its quantity and dollars — in a highlighted label on the segment, e.g. "420.00 sq ft · $1,470". A cutout shows as a deduction, e.g. "−12.50 sq ft · −$44". The measurement\'s own total label stays where it was.',
      'Canvas: a bar at the bottom of the canvas shows what is selected — the measurement\'s name, its takeoff and colour, the measurement total, and the clicked segment\'s amount when one is clicked. For a count marker it shows its price and how many of that takeoff are on the page; with several picked in multi-select it shows how many.',
      'These dollars are the measurement\'s (or segment\'s) share of the takeoff\'s price, split the same way the Takeoffs tab splits it, in whole dollars (not rounded up to the next $100). A takeoff with no pricing shows the quantity only.',
    ],
  },
  {
    version: '4.0.0',
    date: 'September 27, 2026',
    changes: [
      'Document editor: PDFs, Word files, spreadsheets and presentations now open in ONLYOFFICE Docs, which replaces the old PDF editor and spreadsheet editor. Several people can edit the same file at once, with comments, @mentions, track changes and PDF form filling. On phones, documents open to read. The sidebar\'s Document Editor lists recent files and opens one from Documents or from your computer (filed into a project first).',
      'Version 4 runs ONLYOFFICE as a second container next to the app (docs/onlyoffice-setup.md). Settings → Document Editor (admins) checks the connection three ways and says what to fix. Without it, everything else works and documents can be previewed and downloaded, not edited.',
      'Versions: each editing session saves one new version, and the file as it was before stays in its history. Editing a generated document (an invoice, pay app, proposal, RFI…) keeps the generated original as a version, and regenerating always makes a new version (no more "new version or replace?"). Admins, and whoever made a version, can delete older versions. Version history inside the editor shows what changed and restores any version as a new one.',
      'New document: on the Documents page, a project\'s Documents tab and the command palette — a blank Word file, spreadsheet or fillable PDF form, or a template. Admins keep templates, and company stamps, in the new Settings → Document Templates tab.',
      'Signatures and stamps: keep several named signatures with a default under Settings → User Preferences → My signatures (white backgrounds are removed; signatures saved in the old PDF editor move here). In the editor, Insert → Image → From storage adds a signature, a company stamp, a project photo or any other image in the app, and File → Save Copy as saves the copy (e.g. a PDF) into the same project.',
      'Old formats: an uploaded .doc, .xls, .rtf, .odt, .ods, .ppt, Pages, Numbers or Keynote file is converted to .docx, .xlsx or .pptx, and the original is kept as the previous version.',
      'AIA pay apps: Make PDF in the pay app editor, and pay apps can be emailed like invoices, with the PDF attached.',
      'Documents show a thumbnail of each file\'s first page, and of photos.',
      'Notification bell in the sidebar, next to who\'s online: @mentions in document comments, tasks and RFIs assigned to you, and a GC\'s answer to an RFI you sent or are assigned. RFIs have a new Assigned to. Clicking a notification opens what it\'s about.',
      'Phone notifications: turn them on per device under Settings → User Preferences → Phone notifications (on iPhone, from the app added to the Home Screen). Each device can be tested and switched off there.',
      'Viewer: Word, Excel and PowerPoint attachments in Mail open read-only in a new tab, and share links show documents in the same viewer, on phones too.',
      'Sharing: any document can be shared (right-click → Share…), and several documents under one link from the selection bar. New links last 7, 30 (default) or 90 days, or never. A document\'s share window lists every link that opens it, where each can be copied, given a new expiry or stopped; a stopped or expired link says so. Links made before this version keep working with no expiry.',
    ],
  },
  {
    version: '3.3.0',
    date: 'September 25, 2026',
    changes: [
      'Backups, managed by the app: Settings → Backup takes a complete snapshot (database, every file and document, and the mail encryption key) into a backup folder, and after the first one only new or changed files are copied. Set BACKUP_PATH to a second volume; back up on demand or on a schedule; keep as many snapshots as you like; download any snapshot as one zip.',
      'Google Drive backup: connect a Google account once (Drive access only) and snapshots are pushed to a "FrugalOmnibuild Backups" folder (or "Frugal Takeoff Backups" on older installs) on Drive, incrementally.',
      'Local and Google Drive backups have separate daily schedules and keep counts — each can be on or off, at its own time.',
      'A running backup shows a progress bar with its percentage, what it is doing, and how much has been copied.',
      'Setup guide on the Backup page (collapsible): the backup folder and connecting Google Drive step by step, with this server\'s own redirect addresses to copy and fixes for the common Google errors.',
      'Snapshot warnings open to show each one — which file and project it is about, and what it means; run history lists them too. A backup cut off by a server restart is recorded as failed and never blocks the next one.',
      'Disaster recovery: on a fresh install the login page offers "Restore from backup" — pick a snapshot from the backup folder, upload a snapshot zip, or connect Google Drive, and the server rebuilds itself from it and restarts.',
    ],
  },
  {
    version: '3.2.0',
    date: 'September 12, 2026',
    changes: [
      'Schedule of values can be finalized: from the SOV tab, or automatically when the first pay application is created. A finalized SOV refuses line edits (server-enforced) so earlier pay applications never change under you; approved change orders can still be synced in. Admins can reopen it with a warning. A change order already synced into a finalized SOV cannot be deleted.',
      'SOV supports header lines (label-only section titles) and blank spacer lines. They show in the SOV editor, the pay-app G703, and the Excel export, and never count toward any total.',
      'Split an SOV line by percentage: the original becomes a header and each part becomes an item line under it (e.g. 60/40), with item numbers like 5.1, 5.2. Cents always add up to the original. On a project that already has pay applications, the split warns that the new lines start with no billed progress.',
      'SOV editor: contract lines and change-order lines are now separate sections; move lines up/down, insert a header or blank above any line.',
    ],
  },
  {
    version: '3.1.1',
    date: 'September 11, 2026',
    changes: [
      'Mail: saving several attachments from one Gmail message now saves all of them — previously only the first one landed because Gmail hands out new attachment ids on every read. Inline images in a message body load reliably for the same reason.',
      'Documents saved from an email can now be deleted from the Documents page (they are copies; the email keeps the original).',
      'Documents: a "Change type" button in the selection bar re-types several files at once. Files locked to a type by the record they belong to are left alone.',
      'Documents: a very long file name no longer pushes the other columns off the screen — names truncate and show in full on hover.',
      'Canvas: Backspace only removes the last point while drawing; Delete is the only key that deletes the selected measurement.',
      'Online users: click a user to jump to the page they are on. Someone with several tabs open shows each one, and each has its own Follow.',
    ],
  },
  {
    version: '3.1.0',
    date: 'September 9, 2026',
    changes: [
      'Invoice numbers now fill in automatically: a new invoice gets the next number after the highest one used anywhere in the app (numbers are never reused, and you can still type your own).',
      'Invoices can now carry photos and PDF attachments: photos are appended as pages of the generated invoice PDF, and attached PDFs are appended after them in your chosen order — same as change orders and proposals.',
    ],
  },
  {
    version: '3.0.1',
    date: 'September 7, 2026',
    changes: [
      'Fixed: connecting a large Gmail mailbox could get stuck showing "Syncing" with a rate-limit error forever — the initial import restarted from the beginning after every throttle. It now resumes where it left off, paces itself under Gmail\'s speed limit, and waits exactly as long as Google asks before retrying.',
      'While a mailbox import is being throttled, Settings now shows a calm amber "retrying automatically" note instead of a red error.',
    ],
  },
  {
    version: '3.0.0',
    date: 'September 5, 2026',
    changes: [
      'Takeoff Pro 3.0 — this release caps the full UI rehaul (v2.12–v2.14): ambient accent-derived theming, frosted-glass surfaces, springy motion, and customizable card-based dashboard, project, and customer pages are now the standard experience throughout the app.',
      'Daily Reports is now a calendar: days with a report are highlighted in your accent color, tapping a highlighted day opens that report, and tapping an empty day starts one for that date — a toggle switches back to the classic list view (your choice is remembered).',
      'Weekly hour totals (Dashboard, project Time, Time Keeping) now follow a Sunday-to-Saturday week, matching the time sheet calendar.',
      'Fixed: adding photos from a phone now opens the photo picker (with the camera available as a source) instead of jumping straight into the camera — everywhere photos can be added (Issues, Punch, Daily Reports, RFIs, Change Orders, Tasks).',
    ],
  },
  {
    version: '2.14.0',
    date: 'September 5, 2026',
    changes: [
      'Every remaining screen has been brought onto the new glass/token look — Settings, Users, Templates, share pages, Time Keeping, and every project section, plus the canvas toolbar/sidebars/modals — including dark-mode fixes for a handful of dialogs that had stayed light-only until now.',
      'Switching tabs anywhere in the app (Settings, a project\'s sections, and more) now animates the tab indicator and content into place instead of jumping.',
      'The ⌘K command palette has a glossier feel with springy transitions and grouped results that cascade in, remembers your recent picks so they surface first, and its "?" shortcut overlay has been expanded to cover far more of the app\'s shortcuts.',
      'Photos now open in a springy full-screen lightbox with swipe/arrow navigation everywhere photos appear — Issues, Punch List, Daily Reports, RFIs, Change Orders, Tasks, and Proposals.',
      'Small celebration moments: confetti when a bid is won, a soft glow pulse when a payment lands or a document is finalized.',
      'Cards and sections gently reveal as you scroll to them, live progress bars have a subtle breathing animation, and scrollable rails get a fade at the edge to hint there\'s more.',
      'Collaborator cursors on the canvas now glide smoothly between positions instead of jumping frame to frame, with cleaner name tags.',
      'Dashboard/project/customer cards can now be reordered with a touch long-press (not just drag on desktop) and resized by dragging their edge; the "Open tasks" card is back and available on customer pages; and cards linked to a mail thread now open straight into it.',
      'Fixed: Time Keeping\'s week view now starts on Monday everywhere, matching the rest of the app\'s date handling.',
    ],
  },
  {
    version: '2.13.1',
    date: 'September 5, 2026',
    changes: [
      'Dashboard/project/customer cards now pack tightly: a tall card no longer stretches its whole row and strands empty space beside shorter neighbors, and narrower cards fill leftover gaps automatically instead of always starting a fresh row.',
    ],
  },
  {
    version: '2.13.0',
    date: 'September 5, 2026',
    changes: [
      'Dashboard, every project, and every customer page are now built from customizable cards instead of a fixed layout: hit "⚙ Customize" to drag cards into a new order, resize any card from 1 to 3 columns wide, remove ones you don\'t need, and add others from a library of 39 — Reset to default puts a page back the way it started. Your layout is saved per person and follows you to any device you sign in on.',
      'New default Dashboard: "⚡ Needs your attention" surfaces overdue invoices, aging receivables, stalled proposals and the like as one prioritized feed with a link straight to the item, "Money pulse" gives an animated at-a-glance read on what\'s outstanding and what\'s recently moved, plus "On deck" for upcoming deadlines and "Team activity" for what everyone\'s been doing.',
      'New default project page: a "Financial progress" band tracks contract value against billed and paid, "Open items" rolls up outstanding tasks/RFIs/issues/punch items in one place, and "Recent happenings" merges activity and mail into a single project timeline.',
      'New default customer page: "Financials" shows contract-to-date and outstanding balance with an aging breakdown (current / 31-60 days / 61+ days), alongside "Their projects," "Correspondence," and a "Needs attention" card for that customer specifically.',
      'Key figures now animate in with a quick count-up instead of appearing instantly, and several cards carry a small sparkline trend alongside the number.',
      'Pages and lists that have nothing in them yet now show a small illustration instead of a bare "No items" message.',
      'The customer list and the customer detail pane now scroll independently, so a long project or activity list on the right no longer scrolls the customer list on the left out of view.',
    ],
  },
  {
    version: '2.12.0',
    date: 'September 4, 2026',
    changes: [
      'New look throughout the app: an ambient background scene derives its colors from your accent color, and cards, panels, and modals now sit on a soft frosted-glass surface instead of flat panels.',
      'Smoother motion everywhere: moving between pages plays a gentle springy transition, and switching tabs within a page animates in place instead of jumping.',
      'Hover effects on cards and buttons now grow subtly in place, tuned so they never overlap into neighboring elements no matter the screen size.',
      'The sidebar and a project\'s section tabs are now permanently in view and no longer swap out or hide depending on where you are — one consistent global sidebar, with the project\'s sections in a horizontal tab bar at the top.',
      'Who else is online now shows right in the sidebar in place of the old floating bubble — click it to open the presence list and Follow a teammate for a live view of what they\'re doing.',
      'The Login screen has been rebuilt with the same ambient glass look as the rest of the app, and a batch of leftover legacy glass/theme styling was cleaned out behind the scenes.',
      'New preferences: a time-of-day ambience toggle that shifts the ambient scene\'s mood through the day (morning/midday/evening, matching your clock while it\'s on), and a "solid surfaces" toggle for anyone who\'d rather have opaque panels than the glass effect — the app also falls back to solid surfaces automatically when your browser can\'t do the glass blur or you\'ve asked for reduced transparency.',
      'Scrollbars, the fade edge on scrollable panels, and sidebar icons now pick up the glass/accent styling, with icons reacting subtly on hover.',
      'Switching between light and dark mode now plays a short cinematic wipe animation out from the toggle button instead of switching instantly.',
    ],
  },
  {
    version: '2.11.0',
    date: 'September 3, 2026',
    changes: [
      'A mail thread can now be linked straight to a project, a customer, or a specific item — "+ Link" in the conversation opens a picker (Customer / Project / drill into a Task, RFI, Issue, Invoice, Change Order, Pay App, Proposal, Daily Report, or Punch List) and the link shows up everywhere as a real label ("RFI-012", "INV-104") instead of just the item type. Unlink your own links any time; admins can unlink anyone\'s.',
      '"Create ▾" on a conversation turns it straight into a Task, RFI, or Issue — the new item is pre-filled with the thread\'s subject and the latest message\'s text, linked back to the conversation automatically, and opens right in its editor.',
      'Opening a linked conversation now works for everyone on the job, not just whoever\'s mailbox it lives in: if it\'s not in your own mail, you get a read-only reference card (subject, participants, date, and what it\'s linked to) instead of a dead end.',
      'A "Reply" indicator now shows up anywhere a sent document is tracked — invoices, change orders, proposals, issues, RFIs, daily reports, pay applications, and tasks — whenever a reply has come in on its thread since you last sent something on it.',
      'Projects gained a Mail tab: every email conversation linked to that project or one of its items, in one list, with who\'s in it, what it\'s linked to, and a reply indicator — no more hunting through a mailbox to find where a thread went.',
      'Editing an IMAP mail account now starts from what\'s already saved (host, port, username) instead of a blank form.',
      'Fixed: a reply landing on an RFI\'s thread no longer flips its document to "PDF out of date" — arriving mail isn\'t a change to the record.',
      'Fixed: switching threads, folders, or mailboxes while a reply is still being typed now asks before discarding it.',
      'The mail conversation list now scrolls smoothly in very large folders (150+ threads) by only keeping the visible rows on screen.',
    ],
  },
  {
    version: '2.10.0',
    date: 'August 30, 2026',
    changes: [
      'Email now lives in the app. Each person connects their own mailbox — Google Workspace, Microsoft 365, or any IMAP/SMTP host — and the server keeps it indexed in the background, so new mail shows up within seconds on Microsoft and IMAP, and within about half a minute on Gmail.',
      'New Mail tab: a full mailbox inside the app — folders down the left, conversations in the middle, the thread on the right. Read, star, archive, move and trash mail; search across a mailbox; and write with formatting, attachments (uploaded or picked from Documents), reply, reply-all and forward. A message you are part-way through saves itself as a draft, and threads that came from a project record are chipped with what they belong to.',
      'Any attachment on a message can be filed straight into Documents with \'Save to Documents…\' — pick the document type and the project it belongs to, and it lands in the list like any other file.',
      'Settings → Mail is where mailboxes live: connect Google Workspace or Microsoft 365 with a Connect button (no password stored) or fill in any IMAP/SMTP host, give each account its own signature, pick which one sends by default, and remove ones you no longer use.',
      'Sending from proposals, invoices, change orders, issue reports, RFIs, daily reports, punch lists and pay applications now goes out through your own connected mailbox, in the same composer as the rest of the app — so the recipient sees it from you, and it lands in your Sent. Once a document has been emailed, its editor shows a \'Sent · Open thread\' chip that jumps to the conversation, replies and all.',
      'Gmail can now deliver mail in real time instead of waiting for the next check: an admin creates a Google Cloud Pub/Sub topic and points it at the app (Settings → Mail → Server setup guide has the exact steps and URL). It is optional — Gmail keeps checking on a timer either way — and Microsoft and IMAP accounts already arrive instantly.',
      'Note for self-hosters: your old SMTP settings have been migrated into a mail account that starts as "Needs review", and nothing sends until you activate it — open Settings → Mail, confirm the IMAP host and password, and test the connection. Google and Microsoft sign-in also needs a one-time server setup by an admin (see docs/mail-setup.md). This update includes a data-transforming migration (31) plus an additive index (32) — back up before pulling, and keep the new data/mail.key file with your data directory.',
      'RFIs now watch for a reply: when an email comes in on the thread of an RFI you sent, it shows up as a banner on that RFI (and a chip in the RFI list) offering to use it as the response, attachment and all — nothing is recorded automatically, so a reply that isn\'t actually the answer can just be dismissed.',
    ],
  },
  {
    version: '2.9.0',
    date: 'August 29, 2026',
    changes: [
      'One shared document strip now covers every generated PDF/Excel in the app — invoices, change orders, issue reports, punch printouts, RFI responses, daily reports, proposals, and AIA pay applications — showing whether a document exists and is current ("No PDF yet" / "PDF up to date" / "PDF out of date"), with Generate, Open, Download, and Email all in one place. Regenerating a document that already exists always asks first: save as a new version (keeping the old one as history) or overwrite it.',
      'The old "Download PDF" buttons are gone: you now press Generate to build and store the document, then Open it in the viewer or Download it — so the same document the customer gets is the one filed under Documents, instead of a fresh copy every time.',
      'Emailing a document reuses the stored file when it is still current, and rebuilds it first when the record has changed since (or when you pick a different reply-to address). The punch list report has no per-item change history to check, so it always regenerates before sending.',
      'Re-sending a document that was already sent no longer changes its status — in particular, emailing a paid invoice a second time no longer knocks it back to "sent", and a re-send no longer marks its own PDF as out of date.',
      'Recording or deleting a payment, and editing the schedule of values, now mark the related documents out of date: an invoice or pay-application PDF prints Paid and Balance, and every pay application is calculated from the schedule of values, so the status chip flags them for regeneration instead of quietly emailing stale figures.',
      'One shared "Add files" button now covers every photo grid and attachment list — issue/punch/daily-report photos, proposal photos and attachments, RFI responses — letting you upload fresh files or pick from the project\'s existing documents from the same picker, with drag-and-drop support.',
      'Note for self-hosters: this update includes an additive migration (30) that adds an updatedAt column to invoices, change orders, issues, RFIs, and pay applications, so the new document status chip can tell when a record has changed since its last generated document.',
    ],
  },
  {
    version: '2.8.0',
    date: 'August 28, 2026',
    changes: [
      'Proposals reworked into first-class, numbered project records: multi-line pricing that mixes takeoff-derived lines with hand-typed manual lines, an Alternate flag per line with its own subtotal, an optional grand-total, inclusions/exclusions lists, an optional payment schedule, photos with captions, and existing-PDF attachments (upload or pick from the project\'s documents). Revising a proposal clones it into a new numbered draft (e.g. "#2 (rev. of #1)") with the choice to carry photos and attachments along, and the original stays exactly as sent. Accepting a sent proposal can attach a signed copy and offer to prefill the schedule of values from its lines; declining is one click. Proposals live under a new Proposals section per project (admin-only), and the Dashboard gained an "Outstanding proposals" card for sent-but-unanswered proposals sorted by expiry.',
      'Takeoff Print and Excel exports moved off the old proposal page: selecting takeoffs on the Takeoffs tab and printing/exporting now saves the result straight into the project\'s Documents list (as a Takeoff Print / Takeoff Export document) instead of living on a proposal. The Proposal button on that same toolbar starts a new proposal pre-seeded with the selected takeoffs.',
      'New shared "choose an existing file" picker (used by proposal photos/attachments) lets you search and filter the project\'s documents instead of only uploading fresh ones.',
      'Documents gained a "Company document" type for files that aren\'t tied to any project — the upload popup\'s Project and Customer fields both grey out and clear for that type.',
      'Note for self-hosters: this update includes a data-transforming migration (28) that converts every project\'s old proposal history (stored printouts, sent PDF, photos, cover notes/terms) into the new numbered proposal records and relabels old takeoff printouts as Documents entries — back up before pulling this update. A second, additive migration (29) adds a per-project proposal-numbering counter so a deleted proposal\'s number is never reused.',
    ],
  },
  {
    version: '2.7.2',
    date: 'August 27, 2026',
    changes: [
      'Improved: the recent-activity feeds (Dashboard and project Overview) now show the project name on each entry, and clicking an entry jumps to the page it happened on — an RFI event opens that project’s RFIs, a payment opens Billing, and so on. Billing entries only link for admins, since Billing is an admin-only section.',
      'Fix: Project Settings no longer saves while you type. Fields kept auto-saving on every change, which briefly disabled the inputs (losing your cursor) and let live-refresh swap the page mid-edit. Details and contacts now commit with an explicit Save button (with a Discard option), and other users’ screens refresh when you save — not on every keystroke.',
      'Fix: on the daily report form, the man-count description box is now the wide one and the count box the narrow one (they were flipped).',
    ],
  },
  {
    version: '2.7.1',
    date: 'August 26, 2026',
    changes: [
      'New: Daily Reports tab on every project — one report per work day with crew man-counts, field notes, and issues; weather auto-fills with the actual hourly conditions for the day when the project has an address (editable). Reports print/email on the company letterhead with photos attached, and long sections continue cleanly onto a second page.',
    ],
  },
  {
    version: '2.7',
    date: 'August 26, 2026',
    changes: [
      'Real-time collaboration, app-wide: changes other users make (projects, pages, takeoffs, billing, issues, tasks, documents, and more) now appear on your screen live — no refresh needed — and the app warns you when someone else is editing the same thing so you never silently overwrite each other.',
      'Online users list now shows every session per user (each computer/tablet/phone, with an automatic device label), and a Follow button lets you follow a teammate to whatever page they are on.',
      'Canvas drawing rebuilt on server-applied operations: measurements sync live between users, late joiners catch up automatically, page scale and takeoff changes update open canvases in real time, and superseded plan revisions are fully read-only.',
      'Spreadsheet editor rebuilt Google-Sheets-style: opens the real file from Documents with full formatting, edits together live (shared cursors and cell presence), autosaves straight to the file about every 15 seconds (no Save button), and archives a version snapshot of the file as it was before each editing session. Renaming, adding, deleting, and reordering sheets are all safe, and the autosave chip tells you honestly if saving ever fails.',
      'Plan pages you have already viewed are cached in the browser — flipping back and forth between pages is now instant, with a thumbnail preview and download progress while a page loads.',
      'Note for self-hosters: this update adds two new database tables for live spreadsheet sessions (migration 26, additive — existing data untouched).',
    ],
  },
  {
    version: '2.6.1',
    date: 'August 19, 2026',
    changes: [
      'Fix: the Documents page now loads fast on servers with a large number of files. The file list was re-checking every plan page for every document on each load; a database index fix makes that check instant (measured ~2.7 seconds → 6 milliseconds on a 20,000-file test database).',
    ],
  },
  {
    version: '2.6',
    date: 'August 17, 2026',
    changes: [
      'Customers are now the front door: the Customers section is a split view — customer list on the left, and a full landing page per customer on the right with Overview, Projects, Tasks, Billing, and Settings tabs. The Overview surfaces things needing attention (past-due bids, overdue tasks, outstanding money) and Billing rolls up every project\'s contract and payment picture in one place.',
      'Simpler project stages: the Projects board is now two working stages — Bidding and In Progress — plus Archived. Finishing (or losing) a job archives it, and lost bids carry a marker so win/loss history is preserved. Existing projects were moved to the matching stage automatically.',
      'New unified Documents page: a global Documents section lists every file across all projects — uploads, generated invoices, pay apps, change orders, proposals, reports, and photos — each labeled with its type and a link to where it came from. Filter by multiple types/projects/customers at once, multi-select to download or archive, and re-generated documents version instead of duplicating. Admins can define custom document types in Settings, and uploads get a labeling popup (type, customer, project, multiple files at once). Row actions moved to a right-click menu.',
      'Live document previews: hovering a row on the Documents page pops a small preview beside the cursor — photos show the image, PDFs show their first page, all after a short delay so scanning the list stays fast. Clicking a row opens a full preview window with page-by-page PDF navigation, spreadsheet preview, and Download / Open in editor / Source / Archive buttons. (Opening the underlying editor moved to the "Open in editor" button.)',
      'AIA retainage, reworked: set one base retainage rate in Billing → Settings, or switch to per-line rates on the schedule of values. Pay applications can now release retainage in percentage points — release part of it on one application (the remainder carries forward automatically) or hit "Release all" on the final application. Excel exports reflect the effective rates either way.',
      'Clearer billing totals: project cards and customer billing now show two separate rows — Contract (contract total, billed via pay applications, outstanding, paid) and Invoices (invoiced, paid) — instead of one blended number. Figures no longer include drafts.',
      'Balances on every invoice and pay application: the Invoices and Pay Applications tabs gained Amount and Balance columns, and opening an invoice or pay app now lists the payments recorded against it.',
      'Change orders now have a title: shown as a new column in the Change Orders tab and used as the line description when approved change orders sync to the schedule of values.',
      'Fix: uploading documents from another device on the local network no longer fails immediately with an error.',
      'Proposal Cover notes and Terms & Conditions are now remembered: each project keeps what you last generated or sent, new projects prefill with your most recent text, and a history button beside each box offers your last 5 entries to fill with one click (per account, so it follows you across devices).',
      'The proposal page\'s redundant "Header color" picker is gone — proposals follow the Document brand color from Settings, the same as every other generated document.',
    ],
  },
  {
    version: '2.5',
    date: 'August 15, 2026',
    changes: [
      'New Subtract tool for area measurements: cut window and door openings straight out of an area. Select an area measurement, pick Subtract (next to Area, on phone too), and draw the opening — the hole shows the plan through it with a dashed outline, the sidebar lists each cutout as a deduction (e.g. −12.50 sq ft), and every total (canvas, legend, proposal, printouts) uses the net area. Cutouts edit like any segment: drag vertices, move them, undo/redo, and they carry forward across plan revisions.',
      'Fix: printing takeoffs on large plan sets no longer hangs forever or fails. Printouts and proposals were silently rejected by a server upload limit once the PDF got big (about 24+ sheets on heavy plan sets); saves now stream directly without that ceiling, and any failure shows an error message instead of an endless "Generating PDF" spinner. The same silent-hang bug was also fixed in the Excel export.',
      'New Email-ready quality option when printing or generating proposals: keeps the final PDF under 18MB so it clears the ~25MB attachment limits of Gmail/Outlook after email encoding. Small jobs pass through untouched at full quality; big ones are compressed page by page just enough to fit, and if a huge set still can\'t fit at readable quality it saves anyway and warns you with the actual size. The old Full/Large/Standard/Compact choices (which no longer did anything) are gone — it\'s now just Best quality and Email-ready.',
      'Printout downloads are faster and printout files no longer clutter the project Documents list — printout history lives in the Proposal section as before.',
    ],
  },
  {
    version: '2.4',
    date: 'August 11, 2026',
    changes: [
      'Page naming is now yours, not guessed: uploaded plan pages arrive numbered simply 1, 2, 3, … instead of the app trying to auto-detect sheet numbers and titles (which often guessed wrong). All naming happens in the naming window — type it, extract it from a selected region, or use AI Scan. Pages added to an existing set continue numbering after the set\'s highest number, so placeholders never collide.',
      'AI can read just the region you select: the extract tool has a new engine switch — Text/OCR (as before) or AI read, which sends only your selected rectangle to the local AI model and uses exactly the text it sees for the page number or description. Works on one page or across all pages at once, with progress shown. (Needs the AI model available on the server, like AI Scan.)',
      'Clearer "still needs naming" cues: pages that haven\'t been given a real name show an amber Needs-review badge in every naming flow (not just revision review), and the green check only appears once a page is actually named.',
      'Extract All Pages now refreshes revision matching automatically — extracted page numbers immediately re-link new pages to the sheets they revise, without pressing "Re-match by page #".',
      'Fix: printed highlight pages could shift all measurements diagonally on some plan sheets (PDFs from certain CAD tools that place the page origin at the sheet center). Printouts, proposal plan appendices, and PDF-editor saves now place overlays exactly where they were drawn. Regenerate any affected printouts.',
    ],
  },
  {
    version: '2.3',
    date: 'July 30, 2026',
    changes: [
      'RFIs (new): every project now has an RFIs section for formal Requests For Information. Write the question with spec/drawing references, who it\'s directed to, and a response-needed-by date; attach site photos; then download a branded RFI PDF or email it straight to the GC/architect. When the answer comes back, attach the response PDF (or type the response) and the RFI is marked answered — the list highlights overdue RFIs in red until then. RFIs move through Open → Sent → Answered → Closed.',
      'RFI numbers are permanent: RFIs are numbered RFI-001, RFI-002, … per project, and a number is never reused — even if an RFI is deleted — so the numbers you reference in correspondence stay unambiguous.',
      'Download SOV before billing starts: the Billing → Schedule of Values tab now has a "Download SOV" button that exports the standard AIA G702/G703 Excel with all billing at $0 — for presenting the schedule of values for approval before the first pay application. Uses your uploaded AIA template when one is configured.',
      'Fix: AIA Excel exports no longer show a #DIV/0! error in the change-order totals % cell on projects with no change orders.',
      'Tasks now relate to projects and customers: a task can be linked to the project or customer it\'s about (picking a project fills in its customer automatically). Project and customer pages have a Tasks link showing just their tasks, the global task list can be filtered by project or customer, and upcoming task deadlines appear on the Dashboard and on each project\'s Overview.',
    ],
  },
  {
    version: '2.2',
    date: 'July 1, 2026',
    changes: [
      'Plan sets reworked: each sheet now has one living set of measurements that carries across revisions. When you add a new revision of a sheet, its current measurements (and scale) are copied onto the new revision automatically — you no longer end up with duplicate measurements, and the older revision becomes read-only history you can still open and view.',
      'Correct totals & printouts: takeoff totals, printouts, and proposals now count only the current revision of each sheet, so measurements are never double-counted across revisions.',
      'Read-only revision history: opening a superseded revision shows a banner and blocks drawing, dragging, editing, or deleting measurements (with a one-click "Go to current"). Revisions can be compared in an enlarged full-screen overlay with pan/zoom and opacity.',
      'No duplicate pages in a set: naming two pages with the same page number within one plan set is now blocked, with a one-click option to auto-suffix the duplicate (e.g. "A-1 (2)").',
      'More reliable page-name extraction: the extract tool now reads both the PDF\'s embedded text and an OCR pass of the selected area and reconciles them, so garbled or image-only title blocks are matched far more reliably.',
      'AIA export matches your template: the default G702/G703 Excel export now mirrors the standard AIA template, with contract line items and change-order items in separate sections that scale to fit however many rows you have.',
      'Branded documents: generated PDFs (proposals, invoices, change-order requests, issue reports, punch lists) now carry a branded header and footer. Set your company brand colour and choose whether to invert your logo for the dark banner under Settings.',
    ],
  },
  {
    version: '2.1.2',
    date: 'June 24, 2026',
    changes: [
      'Per-user email (SMTP): outgoing email is now configured per user instead of one shared account. Set up your own sending account under Settings → Email, and the proposals, invoices, issue reports, and change-order requests you send go out from your account. (Each user needs to enter their own SMTP settings once.)',
      'New project: plan PDFs are now optional — you can create a project with no pages and add them later. When you do upload PDFs, the upload step now shows a progress bar (and a working indicator while it reads the file) so you can tell it\'s processing and not stuck.',
      'Takeoff templates moved: the Templates tab was removed from the projects page and is now a "Takeoff Templates" section under Settings, which fits better now that projects are more than just takeoffs.',
      'Fixed text-field colours in dark mode on the new-project page (bid due date, plan set, and address fields were styled inconsistently).',
    ],
  },
  {
    version: '2.1.1',
    date: 'June 17, 2026',
    changes: [
      'Custom accent colour: in addition to the preset accent colours, you can now pick any custom colour for the app accent (User Preferences → Accent Colour). The chosen colour is applied across buttons, links, and highlights.',
      'Preferences now follow your account: your appearance settings (dark mode, accent colour including a custom colour, reduced motion) and the project-list sort are saved to your account and applied automatically when you log in on any device — no more re-setting them on each new computer.',
      'User roles: admins can now change a user\'s role (User ⇄ Admin) directly from Settings → User Management. The last remaining admin can\'t be demoted, and you can\'t change your own role.',
      'Change password: every user can now change their own password from Settings → User Preferences (enter your current password, then the new one).',
      'Projects page: the project stages (Estimating, Proposal Sent, Awarded, In Progress, Punch List, Complete, Lost) are now tabs across the top instead of stacked sections, each showing its count — so the board is easier to scan and the selected stage is remembered in the URL.',
    ],
  },
  {
    version: '2.1',
    date: 'June 15, 2026',
    changes: [
      'Email everywhere: invoices, change orders, issue reports, and proposals now open a full email composer instead of a single "To" box. You get a To field with an "Add Cc/Bcc" option, an editable subject and message (both prefilled with a sensible default for the document), and the ability to attach extra files alongside the generated PDF.',
      'Proposals — set price: you can now create a proposal with a fixed lump-sum price instead of pricing from takeoff measurements, for jobs quoted from a site visit. Switch the proposal to "Set price", enter the total, and describe the scope in the cover notes — the proposal PDF shows your price with no takeoff table.',
      'Proposals — photos: attach site photos to a proposal. They are saved on the project and appended to the generated proposal PDF as extra pages.',
      'Proposals — send by email on any project: the "Send proposal" option is now available on every project, not just ones created from an incoming bid email. Proposals created from a bid email still send as a threaded reply.',
      'Project list organization: the projects board now has a separate group for each stage (Estimating, Proposal Sent, Awarded, In Progress, Punch List, Complete, Lost) instead of three lumped groups; a sort control (last updated, date added, name, or bid due date) that is remembered; a "Recently opened" row at the top for quick access; and the bid due date now shows only on projects that are still in the estimating stage.',
      'Fix: saving SMTP email settings failed with a "save failed" error — the secure/port values weren\'t stored correctly. Saving now works, so outgoing email can be configured.',
    ],
  },
  {
    version: '2.0',
    date: 'June 15, 2026',
    changes: [
      'Major release. Frugal-Takeoff is now a full project workspace, not just a takeoff tool. Every project has its own sections — Overview, Pages, Takeoffs, Documents, Billing, Issues, Punch, Tasks, Proposal, and Settings — reachable from a redesigned app shell with a project sidebar, a global command palette (press ⌘K / Ctrl-K), and a refreshed light/dark design system used consistently across the app.',
      'Billing suite: each project now has a dedicated, tabbed Billing area. Create and send invoices with line items and a PDF; record payments against invoices or pay applications; and manage change orders. A live summary keeps the contract total, invoiced, paid, and outstanding figures at a glance.',
      'AIA progress billing: full G702 / G703 support. Build a Schedule of Values (seed it from the estimate, sync approved change orders, or upload a two-column spreadsheet), create monthly Applications for Payment with per-line % complete, stored materials, and retainage, and export faithful AIA G702/G703 Excel documents to send with each month\'s billing.',
      'Change Orders (new): a change order now opens an editor like an invoice — line items, a lump-sum amount, a description, schedule-impact days, and photo attachments. Generate a "Change Order Request" PDF (with an owner/contractor signature block and the photos appended as pages) and email it to the client. Change orders move through Draft → Sent → Approved/Rejected, and approved change orders flow into the contract total and the AIA Schedule of Values.',
      'Issues: log numbered deficiency reports against a project with photos, then generate a printable PDF or email the report to the client.',
      'Punch lists: build area-grouped punch lists with before/during/after photos and a printable punch report.',
      'Tasks: collaborative, assignable task lists replace the old per-project checklists, with assignees and completion tracking.',
      'Proposals: assemble and generate a project proposal PDF from your takeoffs and options, with a saved history of generated proposals.',
      'Documents: every project has a document library with drag-to-upload, file versioning (each re-upload keeps prior versions), filtering, and download — generated invoices, proposals, and change-order requests are filed here automatically.',
      'Dashboard & project lifecycle: a new dashboard summarizes activity, and projects move through clear lifecycle stages (estimating, active, complete, archived) with archive and cleanup tools.',
      'Mobile & tablet: the entire app is now usable on phones and tablets — a slide-in navigation drawer, responsive layouts and tables throughout, and touch-friendly controls. On the takeoff canvas, phones get a clean read-only view while tablets support touch drawing (pinch-zoom, double-tap to finish a measurement, long-press for the action menu).',
      'Foundation & reliability: rebuilt on a normalized database with versioned, automatic migrations and a safe backup/restore + cutover toolchain, plus a large automated test suite (unit + end-to-end) guarding the takeoff canvas, exports, and billing math. Money is handled in exact integer cents throughout, and concurrent edits are protected against conflicts.',
    ],
  },
  {
    version: '1.2.1',
    date: 'May 21, 2026',
    changes: [
      'Printouts: takeoff highlights and the legend are back on rotated sheets. After the move to the vector printout pipeline, any page with PDF rotation — the landscape sheets common to plan sets — came out as the bare page with no measurements or legend, because the overlay step skipped rotated pages. The overlay is now composed in each page\'s displayed orientation and mapped into its content space, so highlights, measurement labels, and the legend land correctly on rotated and unrotated pages alike.',
    ],
  },
  {
    version: '1.2',
    date: 'May 18, 2026',
    changes: [
      'Vector PDF pipeline (project pages): uploaded PDFs are now kept in storage and used as the source for the canvas, printouts, and search. Pages on the canvas render directly from the original PDF on demand and re-render at higher resolution when you zoom in — no more blurry stretched JPEGs at high zoom. Printouts copy the original vector page and stamp measurements / legend on top with pdf-lib, so the exported PDF is a fraction of the previous size and stays crisp at any zoom (measurement labels, legend text, and lines are real vector content now).',
      'Vector PDF pipeline (PDF editor): the standalone editor also stopped storing rasterised pages — it renders each visible page on demand from a live pdf.js document. Sharper text at every zoom, much smaller IndexedDB footprint, and the cached-page JPEG bug that produced fuzzy zooms is gone.',
      'Upload: the source PDF is streamed to the server as binary instead of being base64-encoded in the browser, fixing the out-of-memory crashes large plan sets used to trigger on the new-project upload step.',
      'Upload: OCR only runs on pages that genuinely need it. Text-bearing PDFs (CAD output) get their sheet number / description / search text from the embedded text layer directly, which is both faster and accurate to the character. Image-only or scanned PDFs still fall back to Tesseract.',
      'Page-number / description extraction: drawing a region in the preview modal now pulls text out of the PDF\'s embedded text layer first and only falls back to OCR when the region is image-only. Codes like "A5.0" come back as "A5.0", not the old OCR misread "AS.0".',
      '"Extract All Pages" no longer produces gibberish on non-previewed pages. For vector pages it reads the embedded text per page; for image-only pages it renders the full page at full resolution before OCRing the crop, instead of cropping a 400 px thumbnail.',
      'Page-naming preview: the modal now renders the original PDF page at full quality through pdf.js instead of zooming a small thumbnail. Same modal is shared between new-project upload and the add-pages-to-existing-project flow, so any future fix to either one lands in both at once.',
      'Project search: the cached page text used by the search bar is backfilled from each page\'s source PDF on first open, replacing the upload-era OCR string with the real embedded text. One-shot per page; legacy projects without a source PDF keep working with their existing text.',
      'Canvas: cross-page references are now clickable. If a page\'s embedded text contains another sheet\'s page number (e.g. an "A5.0" inside an elevation\'s section marker), it appears as a faint blue hotspot — pan-mode click takes you to that page. In any other tool the hotspot stays visible as an indicator but doesn\'t intercept clicks, so it can\'t hijack a measurement.',
      'Project page UI: the search bar has a clear button on the right that appears once you type, and pressing Esc inside the box also clears. A "X of Y pages" badge sits below the input while a term is active. Matched substrings in titles and snippets are highlighted in yellow.',
      'Project page UI: press / anywhere on the Pages tab to focus the search box (skipped if you\'re already typing into a different input).',
      'Project page UI: new sort dropdown — Page number (default, numeric), Description (descriptions without one sink to the bottom), or Most highlights first. Choice is persisted per user.',
      'Project page UI: new grid / list view toggle. List view shows a small fixed thumbnail and the full page name with no truncation, so long descriptions stay readable. Also persisted per user.',
      'Project page UI: right-click a page tile or row for a context menu with Open, Open in new tab, Add/Remove favorite, Copy share link, Rename, and Delete page.',
      'Project page UI: pages can be marked as favorites with the star button on the tile or the context menu. Favorites are per-user, per-project, and always sort to the top inside whichever sort mode is active so the sheets you revisit most are one glance away.',
      'Printouts on legacy projects continue to work — pages without a source PDF transparently fall back to embedding the stored raster as before. No data migration required to adopt this release.',
    ],
  },
  {
    version: '1.0.9',
    date: 'May 13, 2026',
    changes: [
      'Page naming OCR: switched to Tesseract\'s high-accuracy "tessdata_best" model for all sheet-number and description extractions — noticeably fewer garbled reads on stylised architectural fonts.',
      'Page naming OCR: added position-aware digit correction — in the numeric body of a sheet number, common letter/digit misreads (S→5, G→6, O→0, I→1, B→8, Z→2) are automatically fixed so codes like "A-S01" or "E-G01" resolve to the correct "A-501" / "E-601".',
    ],
  },
  {
    version: '1.0.8',
    date: 'May 13, 2026',
    changes: [
      'PDF upload: a single failing page no longer silently truncates the rest of the file — the renderer now retries the page (rebuilding the pdf.js worker if needed) and, if it still fails, marks just that page as failed and keeps going.',
      'PDF upload: at the end of an upload the app verifies that the page count it imported matches the page count of the source PDF, and shows a clear alert listing exactly which file and which pages were skipped so missing pages can no longer go unnoticed.',
    ],
  },
  {
    version: '1.0.7',
    date: 'May 12, 2026',
    changes: [
      'Page naming: the "Extract Number / Description" OCR now crops, upscales and contrast-enhances the selected region and constrains Tesseract to sheet-number characters on a single line, so codes like "A1.1" read correctly far more often instead of garbled near-misses.',
      'Page naming: the selection box border is now a thin hairline that stays crisp at any zoom, the corner grabbers have larger hit targets, and dragging a grabber resizes from that corner while the opposite corner stays anchored (it no longer drifts the whole box).',
      'Page naming: the preview now zooms with the mouse wheel toward the cursor and pans with a middle-mouse drag at any zoom level.',
    ],
  },
  {
    version: '1.0.6',
    date: 'May 5, 2026',
    changes: [
      'Time Tracking: monthly calendar heatmap above the entry list — each day shows total hours with shading by intensity, prev/next month navigation, and clicking a day filters the list to that date.',
      'Time Tracking: admins now see a "Team Time" tab that lists every user\'s entries, with a per-user totals summary, a user filter dropdown, and the same calendar heatmap aggregated across the team.',
      'Canvas: real-time collaboration sync now actually reaches other users on the same page — measurement add/update/delete and segment delete events were being broadcast to a room that nobody was joined to, so changes only appeared after a refresh.',
    ],
  },
  {
    version: '1.0.5',
    date: 'May 5, 2026',
    changes: [
      'Time Tracking: new standalone app in the navigation dock — clock in and out with a live running timer, add an optional description when clocking out, log manual entries (date, start/end time, description), and view entries grouped by day with daily and weekly totals. Anonymous sessions see a prompt to log in.',
      'Canvas: pressing Delete when a single segment is selected now removes only that segment instead of the entire measurement. Deleting the primary segment promotes the first additional segment to take its place; deleting the last remaining segment still removes the whole measurement.',
    ],
  },
  {
    version: '1.0.1',
    date: 'May 4, 2026',
    changes: [
      'Printouts: every segment of a multi-segment measurement is now rendered (and arcs are expanded), instead of only the first segment',
      'Canvas: dragging a vertex no longer drags the whole segment along with it — the parent group ignored its own children\'s drag-end events',
      'Canvas: double-clicking a segment line inserts a new vertex at the cursor, ordered between the surrounding pins; works on both primary and additional segments, and on touch via double-tap',
      'Collaboration: the user list now shows one entry per logged-in user even when they have multiple tabs open — the cursor and page come from whichever session is most recently active. Anonymous (not logged in) sessions are hidden from the list and from the canvas cursor layer',
    ],
  },
  {
    version: '1.0',
    date: 'May 4, 2026',
    changes: [
      'Measurements: renaming a measurement from the sidebar while viewing a different page no longer drags the highlight to the current page — the annotation stays put and only the name changes',
      'Drawing tools: length / area / count are now disabled when no measurement or takeoff is selected, and locked to match the type of the selected item so you cannot accidentally start a different kind of measurement; selecting a measurement automatically picks the right tool',
      'Drawing tools: the toolbar now follows the selected measurement\'s own type rather than its takeoff\'s, so a length measurement living inside an area takeoff correctly locks to the line tool',
      'Canvas: pressing Backspace while drawing now removes the last point instead of deleting the whole selected measurement; Delete still removes the selection as before',
      'Canvas: clicking a single segment on a multi-segment measurement now selects just that segment; clicking the measurement in the sidebar still selects the whole thing. Pressing P resumes the specific segment that\'s highlighted, and finalising rewrites that segment in place',
      'Canvas: selecting a segment by clicking it does not change the active tool — only sidebar selection switches the tool, since that signals an intent to draw',
      'Sidebar: a new chevron button at the top of the takeoff list collapses or expands every takeoff at once',
      'Sidebar: when a measurement is selected (from canvas or sidebar), its containing takeoff auto-expands and the row scrolls into view so you never lose track of where the selection lives',
    ],
  },
  {
    version: '0.9.9',
    date: 'April 29, 2026',
    changes: [
      'Measurements: drawing a new segment now correctly appends to the selected measurement instead of silently spawning a fresh one — the first click of the segment used to clear the selection before the canvas could read it',
      'Measurements: a new measurement is only created when nothing is selected; in that case it lands in the currently selected takeoff (or in Ungrouped if no takeoff is selected) so it can be assigned later',
      'Measurements: clicking a measurement in the sidebar now also activates the takeoff it belongs to, so the selected takeoff always matches the selected measurement and new segments inherit the right color and totals group',
    ],
  },
  {
    version: '0.9.7.9',
    date: 'April 23, 2026',
    changes: [
      'Printouts: full-screen progress overlay now appears whenever a PDF or Excel export is being generated, with live status messages so it is clear the app is working and what step it is on (e.g. "Rendering page 2 of 5…", "Adding scope details…", "Saving…")',
      'Proposals: the proposal generator reports each major stage — building cover, adding scope details, terms, rendering blueprint pages, and saving — instead of leaving the user with a greyed-out button',
      'Checklists: the checklist PDF generator reports per-item progress ("Drawing item 4 of 12…") during generation',
      'Shared printouts: fixed "Invalid data" error when opening a shared checklist PDF link — server data-URL parser now accepts the optional ;filename= parameter that jsPDF emits',
      'Shared printouts: PDF previews now use an HTML <object> with a fallback "Download" call-to-action for mobile browsers that can\'t render PDFs inline; the download filename is also normalised to end in .pdf',
      'Checklists: photos are now clickable everywhere they appear (the small thumbnails on the collapsed item row and the larger grid in the expanded view) — clicking opens a full-screen lightbox; click outside or press Esc to close',
      'Documentation: the README has been rewritten from scratch with a full feature overview, setup walkthrough, and placeholders for screenshots',
    ],
  },
  {
    version: '0.9.7.5',
    date: 'April 23, 2026',
    changes: [
      'PDF Editor: "Save As" now opens a native save dialog (File System Access API) on supported browsers so you can rename the file and choose a download location before saving — falls back to the previous direct download on browsers that do not support it',
      'PDF Editor: fixed the toolbar scrolling out of view on smaller desktop screens by switching to dynamic viewport height (100dvh), which also corrects layout on mobile browsers where the address bar reduces the available height',
      'PDF Editor: each page thumbnail in the sidebar now has a delete button (hover to reveal) — deleting a page removes it from the document, shifts all annotation positions, and updates the underlying PDF so the exported file matches what is displayed',
      'PDF Editor: "+" button in the sidebar header lets you import additional pages from a PDF file or from an image (JPEG, PNG, etc.) and append them to the current document',
      'PDF Editor: pages in the sidebar can be reordered by dragging the grip handle — works with both mouse and touch; dragging updates annotation page indices and the PDF page order so the exported file reflects the new layout',
    ],
  },
  {
    version: '0.9.8',
    date: 'April 23, 2026',
    changes: [
      'Proposals: "Include takeoff list" is now an optional checkbox on the proposal modal — when off, the takeoff summary page is omitted and the cost-detail option is disabled',
      'Proposals: the proposal modal now scrolls instead of overflowing on shorter desktop screens; header and footer stay visible',
      'Legend: default font size raised from 14 to 24px and width from 350 to 500px so the legend is legible out of the box on both the canvas and exported PDFs',
      'Legend: styled header bar, separator line, larger corner radius, and a more visible proportional resize handle in the bottom-right corner',
      'Legend: snap-to-corner preset buttons (top-left / top-right / bottom-left / bottom-right) and a text-size slider extended to 72px in the page settings panel',
      'Legend: "Apply legend settings to all pages" batch button copies font size, width, and totals toggle across every page in the project',
      'Legend: project-level "Enable on all pages by default" toggle — pages without an explicit legend setting inherit the project default in both the canvas view and exported PDFs',
      'Pages: selecting multiple pages and sharing now produces one combined link that opens a read-only vertical scroll gallery of all selected pages — no more one link per page',
      'Page naming: when adding pages whose sheet number matches an existing page, the new page is flagged as a "REVISION" with an amber badge and helper text in the naming step',
      'Page naming: sheet number and description are auto-detected from PDF page labels, the filename, or repeated tokens in the extracted text — no more manual entry for cleanly labelled drawings',
      'Page naming: the region-selection preview in the New Project flow now uses the full-resolution image instead of the small thumbnail',
      'Checklists: drag-handle on each item lets you reorder items by drag-and-drop, including across the Pending / Completed divider',
      'Checklists: new "In Progress" photo section between Before and After, including in the printed PDF',
      'Checklists: per-item Comments field for notes, blockers, or reasons an item can\'t be completed yet — printed as a NOTES block on the PDF',
      'Security: app now trusts the first reverse-proxy hop (e.g. Cloudflare) so login rate-limiting buckets per real client IP from X-Forwarded-For instead of all traffic under the proxy address',
    ],
  },
  {
    version: '0.9.7',
    date: 'April 22, 2026',
    changes: [
      'Bid Pipeline: full email integration — bid invitations received by email are automatically imported into the pipeline via IMAP monitoring, or pasted in manually',
      'Bid Pipeline: send proposals as email replies directly from the pipeline using SMTP, with proper reply-threading headers so the response lands in the original conversation',
      'Bid Pipeline: emails in the same conversation are grouped into a single pipeline entry by subject (Re:/Fwd: prefixes stripped for matching); new replies on an existing thread are appended automatically on the next poll',
      'Bid Pipeline: threaded view — click "Show thread (N)" to expand the full conversation newest-first; latest message is auto-expanded, older messages are individually collapsible',
      'Bid Pipeline: HTML emails render with full formatting in a sandboxed iframe instead of plain text',
      'Settings → Email: new tab for configuring outbound SMTP and inbound IMAP accounts (multiple accounts supported)',
      'Settings → Email: provider preset dropdown in the IMAP account form auto-fills server settings for Gmail, Outlook, Yahoo, and iCloud',
      'Settings → Email: Email Provider Setup Guide with step-by-step instructions, direct links to app-password pages, and server settings for Gmail, Outlook, Yahoo, and Apple iCloud',
      'Settings → Email: configurable automatic polling interval (5 min – 1 hr) with a manual Poll Now button',
      'Auth: JWT signing secret is now auto-generated on first boot and persisted in the database — no environment variable setup required for new installs',
      'Security: the public /api/settings endpoint no longer leaks smtp.* or jwt.* keys to unauthenticated callers',
    ],
  },
  {
    version: '0.9.6',
    date: 'April 21, 2026',
    changes: [
      'Estimating: measurements can now have multiple segments — after closing an area or finalising a line, the next click continues adding segments within the same measurement; a "New Measurement" button in the sidebar starts a fresh measurement',
      'Estimating: Ctrl+click (desktop) or the new multi-select toolbar button (mobile) selects multiple measurements of the same type; a Merge button folds all selected areas or lines into a single multi-segment measurement',
      'Estimating: Excel export now matches the Takeoffs tab layout — columns are Name, Type, Qty (formatted), Unit Cost, and Total Cost',
      'Estimating: Excel export includes advanced-pricing detail rows showing item quantities and units (e.g. "5.25 bags of Concrete Mix at $14.00/unit = $73.50") for each custom cost item',
      'Estimating: Excel export groups takeoffs under price-package headers, matching the on-screen grouping',
    ],
  },
  {
    version: '0.9.5.5',
    date: 'April 21, 2026',
    changes: [
      'Mobile: the app navigation sidebar is now hidden when viewing a canvas page on a phone or tablet, giving the full screen to the drawing area',
      'Mobile: the canvas now fills the complete viewport width (previously shifted right by 64px due to the collapsed sidebar)',
      'Mobile: tool toolbar repositioned below the page header on small screens so it is no longer hidden behind it',
      'Mobile: one-finger touch now exclusively draws, selects, or places points — it never pans the canvas',
      'Mobile: two-finger gesture simultaneously pans and pinch-zooms the canvas (drag both fingers to pan, spread/pinch to zoom, or both at once)',
      'Mobile: zoom buttons repositioned higher from the bottom edge so they are not hidden behind iOS/Android browser chrome',
      'Mobile: fixed stuttering during two-finger pan and zoom — Konva stage is now updated imperatively each frame with React state synced via requestAnimationFrame',
    ],
  },
  {
    version: '0.9.5',
    date: 'April 21, 2026',
    changes: [
      'Estimating: middle mouse button now exclusively pans the canvas and can no longer accidentally grab or move a measurement',
      'Estimating: Ctrl-Z undo now covers moving, dragging, and renaming measurements (in addition to adding/deleting)',
      'Estimating: linear area wall heights now default to a single global height; per-point heights are opt-in via a checkbox',
      'Estimating: right-click anywhere on the canvas shows a context menu with Undo, Redo, Copy, Paste, Delete (when over a measurement), and Cancel Drawing (when drawing)',
      'Estimating: double-click on an existing measurement line inserts a new point at that location',
      'Estimating: arcs (A key) now store only 3 points — start, middle, and end — and render as a smooth curve; the 3 handles are draggable to reshape the arc',
      'Projects: clicking the checkbox on a page thumbnail multi-selects pages; a "Share (N)" button copies all share links at once',
      'Projects: scroll position in the pages tab is remembered and restored when returning to the list',
    ],
  },
  {
    version: '0.9.4.1',
    date: 'April 20, 2026',
    changes: [
      'Checklists: data (lists, items, photos) is now stored on the server — checklists are visible across all devices when logged in with the same account',
      'Checklists: one-time automatic migration uploads any locally-stored checklist data and photos from the previous version to the server on first load',
    ],
  },
  {
    version: '0.9.4',
    date: 'April 20, 2026',
    changes: [
      'Checklists: support multiple Before and After photos per item — upload via file picker, drag-and-drop onto the photo zone, or capture from camera; each photo stored independently with per-photo remove button',
      'Checklists: photos are now EXIF-orientation-corrected on upload — phone photos no longer appear rotated in the UI or in generated PDFs',
      'Checklists: PDF export renders all before/after photos in rows (up to 4 per row) per item, with box height calculated dynamically',
      'Checklists: printouts are saved to the server and open in the PDF Editor (same flow as Estimate printouts) instead of about:blank',
      'Checklists: share links — each printout card now has a Share button that generates a /share/<id> URL and copies it to the clipboard',
      'Checklists: mobile-friendly layout — top bar collapses on small screens, list sidebar becomes a slide-over drawer, and photo grid stacks to a single column',
      'Estimating: active measurement tool now makes existing drawn measurements non-interactive (click-through), preventing accidental selection while drawing',
      'Estimating: bid due date removed from proposal PDF cover page',
      'Estimating: total cost values on the Takeoffs tab and in generated PDFs are now rounded up to the nearest $100',
      'Spreadsheet Editor: replaced jspreadsheet-ce with FortuneSheet for a more capable, reliable in-browser spreadsheet experience',
      'Docker: hardened build for native module compilation; added GHA layer caching for faster CI builds',
    ],
  },
  {
    version: '0.9.3',
    date: 'April 15, 2026',
    changes: [
      'Spreadsheet Editor: Excel printouts now open in a full in-browser spreadsheet editor (jspreadsheet) instead of triggering a download — supports editing, multiple sheets, and saving changes back to the Printout or downloading a local copy',
      'Spreadsheet Editor: state persists across navigation and browser restarts via IndexedDB, with multi-tab support for working on several files simultaneously',
      'PDF Editor: rendering quality improved (scale 2×, JPEG quality 0.92) and state now persists across navigation via IndexedDB',
      'Sharing: share links for printouts and project pages — generate a public URL from the Printouts tab or any project page; configure the public host URL under Settings → General → Sharing',
      'Settings: added Sharing card to General Settings tab for configuring the public host URL used in share links',
    ],
  },
  {
    version: '0.9.2.4',
    date: 'April 14, 2026',
    changes: [
      'PDF Editor: split "Save PDF" into two buttons — Save overwrites the original Printout on the server (or downloads locally if opened from a file), Save As always downloads a local annotated copy',
    ],
  },
  {
    version: '0.9.2.3',
    date: 'April 13, 2026',
    changes: [
      'Printouts tab: clicking the View button on a PDF now opens it directly in the PDF Editor instead of a new browser tab',
    ],
  },
  {
    version: '0.9.2.2',
    date: 'April 13, 2026',
    changes: [
      'PDF Editor: fixed exported annotations appearing upside-down — pdf-lib already handles PDF y-up coordinates for embedded images, so the manual vertical flip was double-flipping the overlay',
    ],
  },
  {
    version: '0.9.2.1',
    date: 'April 13, 2026',
    changes: [
      'PDF Editor: text box now reliably appears when clicking — fixed focus being stolen by the Konva canvas on mousedown',
      'PDF Editor: PDF export annotations are no longer upside-down — canvas overlay is now counter-rotated and vertically flipped to match pdf-lib\'s y-up coordinate system before embedding',
    ],
  },
  {
    version: '0.9.2',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor: text annotations are now edited in-place with a floating textarea overlay — no more browser prompt popup',
      'PDF Editor: fixed annotation coordinate offset at non-100% zoom levels — shapes now draw exactly where the cursor lands',
      'PDF Editor: zoom preset menu now opens downward instead of off-screen above the toolbar',
      'PDF Editor: signature and image aspect ratios are preserved when placed — signatures no longer appear squished',
      'PDF Editor: white-background removal for signatures uses a softer gradient threshold (170–220), cleanly removing scanner backgrounds without erasing light ink',
      'PDF Editor: images and signatures are automatically selected after insertion, showing the resize Transformer immediately',
      'PDF Editor: Delete key now removes selected images and signatures in addition to other annotation types',
      'PDF Editor: PDF export now correctly positions annotations on rotated pages (scanned landscape PDFs) using a canvas overlay with rotation-aware pdf-lib placement',
    ],
  },
  {
    version: '0.9.1',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor: multi-file tabs — opening a second PDF creates a new tab above the toolbar; switching tabs preserves each file\'s annotation and undo history independently',
      'PDF Editor: page thumbnail sidebar with per-page thumbnails; clicking scrolls to the page in scroll mode or switches to it in single-page mode; toggleable via toolbar button',
      'PDF Editor: zoom controls — zoom in/out buttons, preset levels (50%–200%), Fit Width, Fit Height, Fit Page; Ctrl+wheel and Ctrl+=/- keyboard shortcuts',
      'PDF Editor: single-page view mode toggle with Previous/Next navigation bar',
    ],
  },
  {
    version: '0.9.0',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor sub-application: open local PDFs, annotate with freehand pen, lines, arrows, rectangles, ellipses, text, and images, then export back to PDF',
      'Signature tool: save reusable signatures from image files with automatic white-background removal, place and resize on any page',
      'Full undo/redo history and keyboard shortcuts in the PDF Editor',
      'Side dock navigation: collapsible/hideable left sidebar with per-app navigation, persistent across sessions',
      'Merged Settings page: user preferences and server settings combined under one route with admin-only tab gating',
      'Advanced costing: Unit label field added to Material Yield and Rate per Units cost types in all takeoff editors',
      'Fixed username display in the active users overlay — eliminated intermittent "User" placeholder caused by async state race',
      'Version changelog added to Settings',
    ],
  },
  {
    version: '0.8.0',
    date: 'April 7–8, 2026',
    changes: [
      'Proposal PDF enhancements: header color picker, custom fonts, cover page notes, valid-until date, terms & conditions page, signature block, and page numbers',
      'Highlight print quality selector with preset options for proposal and standalone printing',
      'Server-side user preference sync for cross-browser persistence',
      'Collaboration user list improvements: numbered duplicate instances and readable page location names',
    ],
  },
  {
    version: '0.7.0',
    date: 'April 5–6, 2026',
    changes: [
      'Price package field on takeoffs with automatic grouping in sidebar',
      'Custom autocomplete dropdown for price package selection',
      'Shared NewTakeoffModal component extracted for reuse',
      'Proposal PDF takeoff list grouped by price package',
      'Append highlighted blueprint pages to proposal PDF using pdf-lib merge',
    ],
  },
  {
    version: '0.6.0',
    date: 'April 4, 2026',
    changes: [
      'Proposal PDF generator with branded cover page and takeoff summary',
      'Accent color system replacing all hardcoded blues throughout the app',
    ],
  },
  {
    version: '0.5.0',
    date: 'April 3, 2026',
    changes: [
      'Glass UI design with dark mode support',
      'Accent color picker in user settings',
      'Dark mode applied across all pages and components',
      'Toast notifications for user feedback',
      'Undo/redo support for measurements',
      'Keyboard shortcuts for common actions',
    ],
  },
  {
    version: '0.4.0',
    date: 'April 2, 2026',
    changes: [
      'Security hardening: rate limiting, input validation, and query optimization',
      'Fixed authentication header handling across all views',
      'Performance improvements for large project lists',
    ],
  },
  {
    version: '0.3.0',
    date: 'March 29–31, 2026',
    changes: [
      'Project notes with rich text support',
      'Server settings page for application branding and contractor info',
      'Search with persistence and term highlighting',
      'Global user presence and real-time collaboration controls',
    ],
  },
  {
    version: '0.2.0',
    date: 'March 24–28, 2026',
    changes: [
      'Legend display and customization on canvas pages',
      'Copy/paste functionality for measurements',
      'Ability to resume incomplete measurements',
    ],
  },
  {
    version: '0.1.0',
    date: 'March 11–21, 2026',
    changes: [
      'Initial project structure with React, TypeScript, and Tailwind CSS',
      'Express.js backend with SQLite database',
      'JWT authentication and user management',
      'PDF blueprint upload, rendering, and page navigation',
      'Canvas-based measurement tools (linear, area, count)',
      'Takeoff cost management and bid tracking',
      'Real-time collaboration via Socket.IO',
      'Thumbnail generation and plan set versioning',
      'Docker deployment configuration',
    ],
  },
];

// ── User Preferences tab ─────────────────────────────────────────────────────

const ACCENT_PRESETS: { key: AccentKey; label: string; hue: number }[] = [
  { key: 'blue',    label: 'Blue',    hue: 264 },
  { key: 'indigo',  label: 'Indigo',  hue: 283 },
  { key: 'violet',  label: 'Violet',  hue: 303 },
  { key: 'emerald', label: 'Emerald', hue: 162 },
  { key: 'rose',    label: 'Rose',    hue: 15  },
  { key: 'amber',   label: 'Amber',   hue: 84  },
];

function accentSwatchColor(hue: number) {
  return `oklch(0.52 0.24 ${hue})`;
}

const PreferencesTab: React.FC = () => {
  const { mode, accentColor, customAccentHex, reducedMotion, timeAmbience, solidSurfaces, toggleMode, setAccentColor, setCustomAccent, setReducedMotion, setTimeAmbience, setSolidSurfaces } = useTheme();
  const { toast } = useToast();
  const isAdminUser = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; } })();
  const [openTab, setOpenTab] = useState<string>('overview');
  useEffect(() => { getDefaultProjectTab().then(setOpenTab); }, []);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [autoName, setAutoName] = useState<boolean>(aiAutoNameEnabled());
  const [aiIdleMinutes, setAiIdleMinutes] = useState<string>('5');
  const [aiSettings, setAiSettings] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = await getAiStatus(true);
      if (cancelled) return;
      setAiStatus(s);
      // While the model is downloading/loading, keep polling so the page flips
      // to "ready" on its own without a manual refresh.
      if (s.state === 'loading') timer = setTimeout(tick, 5000);
    };
    tick();
    // Load the idle-timeout setting
    getSettings().then(s => {
      if (cancelled) return;
      setAiSettings(s);
      if (s['aiIdleTimeoutMinutes'] !== undefined) setAiIdleMinutes(s['aiIdleTimeoutMinutes']);
    }).catch(() => {});
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const handleAiIdleBlur = async () => {
    const val = aiIdleMinutes.trim();
    const num = parseFloat(val);
    const safe = isNaN(num) || num < 0 ? '5' : String(num);
    setAiIdleMinutes(safe);
    try {
      await saveSettings({ ...(aiSettings ?? {}), aiIdleTimeoutMinutes: safe });
      setAiSettings(prev => ({ ...(prev ?? {}), aiIdleTimeoutMinutes: safe }));
    } catch (err: any) {
      toast(err?.message?.includes('admin') || err?.message?.includes('403') ? 'Only admins can change this.' : (err?.message ?? 'Failed to save.'), { type: 'error' });
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast('New password must be at least 6 characters', { type: 'error' });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('New passwords do not match', { type: 'error' });
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to change password');
      toast('Password changed', { type: 'success' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      toast(err.message, { type: 'error' });
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink">Appearance</h2>
          <p className="text-sm text-ink-soft">Control how the application looks and feels.</p>
        </div>
        <div className="p-6 space-y-6">
          {/* Dark Mode */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                <AnimatePresence mode="wait" initial={false}>
                  {mode === 'dark' ? (
                    <motion.div key="moon"
                      initial={{ opacity: 0, rotate: -30, scale: 0.7 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: 30, scale: 0.7 }} transition={{ duration: 0.18 }}>
                      <Moon size={18} />
                    </motion.div>
                  ) : (
                    <motion.div key="sun"
                      initial={{ opacity: 0, rotate: 30, scale: 0.7 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: -30, scale: 0.7 }} transition={{ duration: 0.18 }}>
                      <Sun size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Dark Mode</p>
                <p className="text-xs text-ink-soft mt-0.5">Switch between light and dark interface</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={mode === 'dark'} onClick={toggleMode}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised ${mode === 'dark' ? 'bg-accent-600' : 'bg-edge-strong'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${mode === 'dark' ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>

          {/* Reduce Motion */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                {reducedMotion ? <ZapOff size={16} /> : <Zap size={16} />}
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Reduce Motion</p>
                <p className="text-xs text-ink-soft mt-0.5">Minimize animations for accessibility or performance</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised ${reducedMotion ? 'bg-accent-600' : 'bg-edge-strong'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${reducedMotion ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>

          {/* Time-of-day ambience */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                <Sunrise size={16} />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Time-of-day ambience</p>
                <p className="text-xs text-ink-soft mt-0.5">Background scene warms and cools with the clock (always in your accent's hues)</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={timeAmbience} onClick={() => setTimeAmbience(!timeAmbience)}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised ${timeAmbience ? 'bg-accent-600' : 'bg-edge-strong'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${timeAmbience ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>

          {/* Solid surfaces */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                <Layers size={16} />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink">Solid surfaces</p>
                <p className="text-xs text-ink-soft mt-0.5">Replace translucent glass panels with solid ones (better on low-power devices)</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={solidSurfaces} onClick={() => setSolidSurfaces(!solidSurfaces)}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised ${solidSurfaces ? 'bg-accent-600' : 'bg-edge-strong'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${solidSurfaces ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink">Projects</h2>
          <p className="text-sm text-ink-soft">Choose which tab a project opens on.</p>
        </div>
        <div className="p-6">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-semibold text-ink">Open projects on</span>
            <select
              aria-label="Open projects on"
              value={openTab}
              onChange={async e => {
                const next = e.target.value;
                const prev = openTab;
                setOpenTab(next);
                try { await setDefaultProjectTab(next); }
                catch { setOpenTab(prev); toast('Could not save this setting.', { type: 'error' }); }
              }}
              className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink"
            >
              {PROJECT_SECTIONS.filter(s => !s.adminOnly || isAdminUser).map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink">Accent Colour</h2>
          <p className="text-sm text-ink-soft">Applied to buttons, active states, and interactive elements.</p>
        </div>
        <div className="p-6">
          <div className="flex items-center gap-3 flex-wrap">
            {ACCENT_PRESETS.map(preset => (
              <button
                key={preset.key}
                onClick={() => setAccentColor(preset.key)}
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={accentColor === preset.key}
                className="relative w-9 h-9 rounded-full transition-transform hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-raised"
                style={{ background: accentSwatchColor(preset.hue) } as React.CSSProperties}
              >
                <AnimatePresence>
                  {accentColor === preset.key && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.15 }}
                      className="absolute inset-0 flex items-center justify-center rounded-full ring-2 ring-white ring-offset-2"
                    >
                      <Check size={14} className="text-white drop-shadow" strokeWidth={3} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>
            ))}

            {/* Custom colour — native colour picker behind a swatch */}
            <label
              title="Custom colour"
              aria-label="Custom accent colour"
              className="relative w-9 h-9 rounded-full cursor-pointer transition-transform hover:scale-110 active:scale-95 focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-raised"
              style={{ background: customAccentHex } as React.CSSProperties}
            >
              <input
                type="color"
                value={customAccentHex}
                aria-label="Pick a custom accent colour"
                onChange={(e) => setCustomAccent(e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <AnimatePresence>
                {accentColor === 'custom' && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.15 }}
                    className="absolute inset-0 flex items-center justify-center rounded-full ring-2 ring-white ring-offset-2 pointer-events-none"
                  >
                    <Check size={14} className="text-white drop-shadow" strokeWidth={3} />
                  </motion.div>
                )}
              </AnimatePresence>
            </label>
          </div>
          <p className="text-xs text-ink-soft mt-4">
            Current:{' '}
            <span className="font-medium text-ink capitalize">
              {accentColor === 'custom' ? customAccentHex : accentColor}
            </span>
          </p>
        </div>
      </div>

      {/* AI Sheet Reading */}
      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <Sparkles size={18} /> AI Sheet Reading
          </h2>
          <p className="text-sm text-ink-soft mt-1">
            {aiStatus?.state === 'ready'
              ? `Local model ready: ${aiStatus.model} (${aiStatus.device}).`
              : aiStatus?.state === 'loading'
              ? 'Model is starting up — on first run it downloads the weights (this can take several minutes). Watch the container log for download progress. This will update automatically.'
              : aiStatus?.state === 'idle'
              ? `Local model idle: ${aiStatus.model} (${aiStatus.device}).`
              : 'No local model detected. Page naming falls back to text/OCR extraction. See the ops runbook to enable it.'}
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-ink">Enable AI sheet reading</p>
              <p className="text-xs text-ink-soft mt-0.5">
                Renders page images for AI and shows the AI Scan button on the naming screen. Nothing runs until you click AI Scan.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoName}
              disabled={!aiStatus?.available}
              onClick={() => { const next = !autoName; setAutoName(next); setAiAutoNameEnabled(next); }}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised disabled:opacity-50 disabled:cursor-not-allowed ${autoName && aiStatus?.available ? 'bg-accent-600' : 'bg-edge-strong'}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-all ${autoName && aiStatus?.available ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">Unload model after (minutes idle)</p>
              <p className="text-xs text-ink-soft mt-0.5">
                Frees GPU memory when idle. 0 = keep loaded.
              </p>
            </div>
            <div className="w-24 shrink-0">
              <NumberInput allowEmpty
                min="0"
                step="1"
                value={aiIdleMinutes}
                onChange={e => setAiIdleMinutes(e.target.value)}
                onBlur={handleAiIdleBlur}
                disabled={!aiStatus?.available}
                className="py-1.5"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Phone notifications (ONLYOFFICE Phase 5) */}
      <PhoneNotifications />

      {/* My signatures (ONLYOFFICE Phase 3) */}
      <MySignatures />

      {/* Change Password */}
      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <Lock size={18} className="text-accent-600 dark:text-accent-400" />
            Change Password
          </h2>
          <p className="text-sm text-ink-soft">Update the password you use to sign in.</p>
        </div>
        <form onSubmit={handleChangePassword} className="p-6 space-y-4 max-w-md">
          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password">
            <Input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              autoComplete="new-password"
              required
            />
          </Field>
          <button
            type="submit"
            disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
            className="flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {savingPassword ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Change Password
          </button>
        </form>
      </div>
    </div>
  );
};

// ── Changelog tab ─────────────────────────────────────────────────────────────

const ChangelogTab: React.FC = () => (
  <div className="space-y-6">
    {CHANGELOG.map((entry, i) => (
      <div key={entry.version} className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge flex items-center gap-3">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
            v{entry.version}
          </span>
          <span className="text-sm text-ink-soft">{entry.date}</span>
          {i === 0 && (
            <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
              Latest
            </span>
          )}
        </div>
        <div className="p-6">
          <ul className="space-y-2">
            {entry.changes.map((change, j) => (
              <li key={j} className="flex items-start gap-3 text-sm text-ink">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
                {change}
              </li>
            ))}
          </ul>
        </div>
      </div>
    ))}
  </div>
);

const StorageTab: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [orphans, setOrphans] = useState<{ count: number; bytes: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, o] = await Promise.all([getStorageStats(), getStorageOrphans().catch(() => null)]);
      setStats(s);
      setOrphans(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load storage usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCleanup = async () => {
    if (!orphans || orphans.count === 0) return;
    const ok = await confirm({
      title: 'Reclaim space',
      message: `Permanently delete ${orphans.count} unreferenced file${orphans.count === 1 ? '' : 's'} (${formatBytes(orphans.bytes)})? This cannot be undone.`,
      confirmLabel: 'Delete files',
      tone: 'danger',
    });
    if (!ok) return;
    setCleaning(true);
    try {
      const { deleted, bytesFreed } = await cleanupStorageOrphans();
      toast(`Reclaimed ${formatBytes(bytesFreed)} from ${deleted} file${deleted === 1 ? '' : 's'}`, { type: 'success' });
      await load();
    } catch {
      toast('Failed to reclaim space', { type: 'error' });
    } finally {
      setCleaning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="bg-raised rounded-2xl border border-edge shadow-sm p-6">
        <p className="text-sm text-red-500">{error || 'No data available.'}</p>
        <button onClick={load} className="mt-4 px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-2">
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  const categories = [
    { key: 'images', label: 'Files & Images', color: 'bg-accent-500' },
    { key: 'projects', label: 'Projects', color: 'bg-blue-500' },
    { key: 'notes', label: 'Notes', color: 'bg-amber-500' },
    { key: 'templates', label: 'Templates', color: 'bg-purple-500' },
    { key: 'checklists', label: 'Checklists', color: 'bg-pink-500' },
  ] as const;
  const breakdownTotal = Object.values(stats.breakdown).reduce((a, b) => a + b, 0) || 1;
  const maxProject = stats.projects[0]?.totalBytes || 1;

  return (
    <div className="space-y-6">
      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="text-accent-600" size={22} />
            <div>
              <h2 className="text-lg font-bold text-ink">Storage Usage</h2>
              <p className="text-sm text-ink-soft">How much disk space the application's data occupies.</p>
            </div>
          </div>
          <button onClick={load} title="Refresh" className="p-2 rounded-lg text-ink-faint hover:text-accent-600 hover:bg-hover transition-all">
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl bg-sunken/50 p-4">
            <div className="text-2xl font-bold text-ink">{formatBytes(stats.databaseBytes)}</div>
            <div className="text-xs uppercase tracking-wider text-ink-soft mt-1">Database on disk</div>
          </div>
          <div className="rounded-xl bg-sunken/50 p-4">
            <div className="text-2xl font-bold text-ink">{stats.projectCount.toLocaleString()}</div>
            <div className="text-xs uppercase tracking-wider text-ink-soft mt-1">Projects</div>
          </div>
          <div className="rounded-xl bg-sunken/50 p-4">
            <div className="text-2xl font-bold text-ink">{stats.imageCount.toLocaleString()}</div>
            <div className="text-xs uppercase tracking-wider text-ink-soft mt-1">Stored files</div>
          </div>
        </div>
      </div>

      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink">Breakdown by Type</h2>
          <p className="text-sm text-ink-soft">Content size stored in each part of the database.</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-sunken">
            {categories.map(c => {
              const bytes = stats.breakdown[c.key];
              if (!bytes) return null;
              return <div key={c.key} className={c.color} style={{ width: `${(bytes / breakdownTotal) * 100}%` }} title={`${c.label}: ${formatBytes(bytes)}`} />;
            })}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {categories.map(c => (
              <div key={c.key} className="flex items-center gap-3 text-sm">
                <span className={`w-2.5 h-2.5 rounded-full ${c.color} shrink-0`} />
                <span className="text-ink-soft">{c.label}</span>
                <span className="ml-auto font-medium text-ink">{formatBytes(stats.breakdown[c.key])}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {orphans && (
        <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
          <div className="p-6 border-b border-edge">
            <h2 className="text-lg font-bold text-ink flex items-center gap-2">
              <Sparkles size={18} className="text-accent-600" /> Reclaim Space
            </h2>
            <p className="text-sm text-ink-soft">Unreferenced files left behind by failed uploads or deleted pages and plan-set revisions.</p>
          </div>
          <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              {orphans.count === 0 ? (
                <p className="text-sm text-ink-soft">No orphaned files — storage is clean.</p>
              ) : (
                <p className="text-sm text-ink-soft">
                  <span className="font-bold text-ink">{orphans.count.toLocaleString()}</span> orphaned file{orphans.count === 1 ? '' : 's'} taking up <span className="font-bold text-ink">{formatBytes(orphans.bytes)}</span>.
                </p>
              )}
            </div>
            <button
              onClick={handleCleanup}
              disabled={orphans.count === 0 || cleaning}
              className="shrink-0 px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {cleaning ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {cleaning ? 'Reclaiming…' : 'Reclaim space'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink">Usage by Project</h2>
          <p className="text-sm text-ink-soft">Projects ranked by total space used, including their files.</p>
        </div>
        <div className="p-6">
          {stats.projects.length === 0 ? (
            <p className="text-sm text-ink-soft">No projects yet.</p>
          ) : (
            <div className="space-y-3">
              {stats.projects.map(p => (
                <div key={p.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="truncate text-ink">{p.name}</span>
                    <span className="font-medium text-ink whitespace-nowrap">{formatBytes(p.totalBytes)}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-sunken overflow-hidden">
                    <div className="h-full rounded-full bg-accent-500" style={{ width: `${(p.totalBytes / maxProject) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── AIA Export Template tab ────────────────────────────────────────────────────

// Default mapping — sensible starting point the admin edits rather than a blank
// form. Mirrors AiaTemplateMapping in aiaExcel.ts (kept structural to avoid a
// runtime dependency on the lazy-loaded exceljs module).
interface AiaMapping {
  g702Sheet: string;
  cells: Record<string, string>;
  g703Sheet: string;
  g703StartRow: number;
  g703Cols: Record<string, string>;
  moneyAsDollars: boolean;
}

const G702_CELL_FIELDS: { key: string; label: string }[] = [
  { key: 'ownerName', label: 'Owner name' },
  { key: 'ownerAddress', label: 'Owner address' },
  { key: 'projectName', label: 'Project name' },
  { key: 'contractorName', label: 'Contractor name' },
  { key: 'architectName', label: 'Architect name' },
  { key: 'contractFor', label: 'Contract for' },
  { key: 'applicationNo', label: 'Application no.' },
  { key: 'periodTo', label: 'Period to' },
  { key: 'applicationDate', label: 'Application date' },
  { key: 'contractDate', label: 'Contract date' },
  { key: 'ownerProjectNumber', label: 'Owner project no.' },
  { key: 'architectProjectNumber', label: 'Architect project no.' },
  { key: 'retainageWorkPct', label: 'Retainage % (work)' },
  { key: 'retainageStoredPct', label: 'Retainage % (stored)' },
  { key: 'L1', label: 'Line 1 — Original contract sum' },
  { key: 'L2', label: 'Line 2 — Net change orders' },
  { key: 'L3', label: 'Line 3 — Contract sum to date' },
  { key: 'L4', label: 'Line 4 — Total completed & stored' },
  { key: 'L5a', label: 'Line 5a — Retainage (work)' },
  { key: 'L5b', label: 'Line 5b — Retainage (stored)' },
  { key: 'L5', label: 'Line 5 — Total retainage' },
  { key: 'L6', label: 'Line 6 — Earned less retainage' },
  { key: 'L7', label: 'Line 7 — Less previous certificates' },
  { key: 'L8', label: 'Line 8 — Current payment due' },
  { key: 'L9', label: 'Line 9 — Balance to finish' },
  { key: 'coAdditions', label: 'CO additions' },
  { key: 'coDeductions', label: 'CO deductions' },
  { key: 'coNet', label: 'CO net change' },
];

const G703_COL_FIELDS: { key: string; label: string }[] = [
  { key: 'itemNo', label: 'Item no.' },
  { key: 'description', label: 'Description' },
  { key: 'scheduledValue', label: 'Scheduled value (C)' },
  { key: 'previous', label: 'Previous (D)' },
  { key: 'thisPeriod', label: 'This period (E)' },
  { key: 'stored', label: 'Stored (F)' },
  { key: 'total', label: 'Total to date (G)' },
  { key: 'percent', label: '% (G/C)' },
  { key: 'balance', label: 'Balance (I)' },
  { key: 'retainage', label: 'Retainage (J)' },
];

const DEFAULT_AIA_MAPPING: AiaMapping = {
  g702Sheet: 'G702',
  cells: {},
  g703Sheet: 'G703',
  g703StartRow: 2,
  g703Cols: {
    itemNo: 'A', description: 'B', scheduledValue: 'C', previous: 'D',
    thisPeriod: 'E', stored: 'F', total: 'G', percent: 'H', balance: 'I', retainage: 'J',
  },
  moneyAsDollars: true,
};

const AiaTemplateTab: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templateFileId, setTemplateFileId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [mapping, setMapping] = useState<AiaMapping>(DEFAULT_AIA_MAPPING);

  useEffect(() => {
    (async () => {
      try {
        const s = await getSettings();
        if (s.aiaTemplateFileId) setTemplateFileId(s.aiaTemplateFileId);
        if (s.aiaTemplateName) setTemplateName(s.aiaTemplateName);
        if (s.aiaTemplateMapping) {
          try {
            const parsed = JSON.parse(s.aiaTemplateMapping);
            setMapping({ ...DEFAULT_AIA_MAPPING, ...parsed,
              cells: { ...parsed.cells }, g703Cols: { ...DEFAULT_AIA_MAPPING.g703Cols, ...parsed.g703Cols } });
          } catch { /* keep defaults on parse error */ }
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  const setCell = (key: string, val: string) =>
    setMapping(m => ({ ...m, cells: { ...m.cells, [key]: val } }));
  const setCol = (key: string, val: string) =>
    setMapping(m => ({ ...m, g703Cols: { ...m.g703Cols, [key]: val } }));

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-uploading the same filename
    if (!file) return;
    try {
      // settings-asset keeps the template out of the Documents page; it belongs to
      // no project or entity, so it carries no projectId/source. The read path
      // (getFile → dataUrl) is unchanged — the server still reconstructs a dataURL.
      const { fileId } = await saveBinaryFile(uuidv4(), file, {
        kind: 'settings-asset', name: file.name,
      });
      await saveSettings({ aiaTemplateFileId: fileId, aiaTemplateName: file.name });
      setTemplateFileId(fileId);
      setTemplateName(file.name);
      toast('Template uploaded', { type: 'success' });
    } catch {
      toast('Failed to upload template', { type: 'error' });
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: 'Remove template',
      message: 'Remove the configured AIA template? Exports will revert to the standard generated G702/G703.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await saveSettings({ aiaTemplateFileId: '', aiaTemplateName: '' });
      setTemplateFileId('');
      setTemplateName('');
      toast('Template removed', { type: 'success' });
    } catch {
      toast('Failed to remove template', { type: 'error' });
    }
  };

  const handleSaveMapping = async () => {
    setSaving(true);
    try {
      await saveSettings({ aiaTemplateMapping: JSON.stringify(mapping) });
      toast('Mapping saved', { type: 'success' });
    } catch {
      toast('Failed to save mapping', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" /></div>;

  return (
    <div className="space-y-6">
      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <FileSpreadsheet size={20} className="text-accent-600" /> AIA Export Template
          </h2>
          <p className="text-sm text-ink-soft mt-1">
            Upload your AIA G702/G703 .xlsx and map each value to the cell it should fill. Leave a cell blank to skip it. When no template is set, the app generates a standard G702/G703.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleUpload} className="hidden" id="aia-template-upload" />
            <label htmlFor="aia-template-upload"
              className="inline-flex items-center gap-2 px-4 py-2 bg-raised border border-edge rounded-lg text-sm font-medium text-ink hover:bg-hover cursor-pointer transition-all shadow-sm">
              <FileSpreadsheet size={16} /> {templateFileId ? 'Replace Template' : 'Upload .xlsx Template'}
            </label>
            {templateFileId ? (
              <>
                <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5">
                  <CheckCircle size={15} /> {templateName || 'Template configured'}
                </span>
                <button onClick={handleRemove} className="text-sm text-red-500 hover:text-red-600 font-medium flex items-center gap-1">
                  <Trash2 size={14} /> Remove
                </button>
              </>
            ) : (
              <span className="text-sm text-ink-soft">No template configured — using the standard generated export.</span>
            )}
          </div>
        </div>
      </div>

      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h3 className="text-base font-bold text-ink">G702 — Sheet & Cell Mapping</h3>
        </div>
        <div className="p-6 space-y-4">
          <div className="max-w-xs">
            <Field label="G702 sheet name">
              <Input value={mapping.g702Sheet} onChange={e => setMapping(m => ({ ...m, g702Sheet: e.target.value }))} placeholder="G702 or 1" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {G702_CELL_FIELDS.map(f => (
              <div key={f.key}>
                <Field label={f.label}>
                  <Input value={mapping.cells[f.key] || ''} onChange={e => setCell(f.key, e.target.value)} placeholder="e.g. F20" />
                </Field>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h3 className="text-base font-bold text-ink">G703 — Continuation Sheet Mapping</h3>
          <p className="text-sm text-ink-soft mt-1">Each schedule-of-values line writes into a row, starting at the start row. Provide the column letter for each value.</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div>
              <Field label="G703 sheet name">
                <Input value={mapping.g703Sheet} onChange={e => setMapping(m => ({ ...m, g703Sheet: e.target.value }))} placeholder="G703 or 1" />
              </Field>
            </div>
            <div>
              <Field label="First data row">
                <NumberInput min={1} value={mapping.g703StartRow}
                  onChange={e => setMapping(m => ({ ...m, g703StartRow: parseInt(e.target.value) || 1 }))} placeholder="2" />
              </Field>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {G703_COL_FIELDS.map(f => (
              <div key={f.key}>
                <Field label={f.label}>
                  <Input value={mapping.g703Cols[f.key] || ''} onChange={e => setCol(f.key, e.target.value)} placeholder="e.g. C" />
                </Field>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSaveMapping} disabled={saving}
          className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2">
          <Save size={16} /> {saving ? 'Saving…' : 'Save Mapping'}
        </button>
      </div>
    </div>
  );
};

// Admin "Document types" card (spec §Decisions "Custom types"): custom kinds
// available in the upload popup, type filters, and a direct upload's "Change
// type" action — system types are locked and never appear here. Ids are
// slugged from the label at add time (falling back to a short random suffix
// on collision/empty), and every file stores the id, not the label — a
// rename just edits settings.documentTypes, no file rows change.
const DocumentTypesCard: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [types, setTypes] = useState<CustomDocType[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    getDocumentTypes().then(setTypes).catch(() => setTypes([])).finally(() => setLoading(false));
  }, []);

  const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  const uniqueId = (label: string, existing: CustomDocType[]): string => {
    const base = slugify(label) || 'type';
    return existing.some(t => t.id === base) ? `${base}-${uuidv4().slice(0, 6)}` : base;
  };

  const handleAdd = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    try {
      const next = [...types, { id: uniqueId(label, types), label }];
      await saveDocumentTypes(next);
      setTypes(next);
      setNewLabel('');
      toast('Document type added', { type: 'success' });
    } catch {
      toast('Failed to add type', { type: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const startRename = (t: CustomDocType) => { setEditingId(t.id); setEditLabel(t.label); };
  const cancelRename = () => { setEditingId(null); setEditLabel(''); };

  const saveRename = async (id: string) => {
    const label = editLabel.trim();
    if (!label) return;
    setBusyId(id);
    try {
      const next = types.map(t => t.id === id ? { ...t, label } : t);
      await saveDocumentTypes(next);
      setTypes(next);
      cancelRename();
      toast('Renamed', { type: 'success' });
    } catch {
      toast('Failed to rename', { type: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (t: CustomDocType) => {
    setBusyId(t.id);
    try {
      // GET /api/documents can only ask for "archived" or "not archived" in
      // one call (no "either" mode) — sum both so a type still referenced by
      // an archived-only row still blocks deletion (its files would be left
      // with an unresolvable kind id otherwise).
      const [active, archived] = await Promise.all([
        getDocuments({ kinds: [`custom:${t.id}`], limit: 1 }),
        getDocuments({ kinds: [`custom:${t.id}`], limit: 1, archived: true }),
      ]);
      const inUse = active.total + archived.total;
      if (inUse > 0) {
        toast(`In use by ${inUse} document${inUse === 1 ? '' : 's'} — can't delete`, { type: 'error' });
        return;
      }
      const ok = await confirm({
        title: 'Delete document type',
        message: `Delete "${t.label}"? This can't be undone.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return;
      const next = types.filter(x => x.id !== t.id);
      await saveDocumentTypes(next);
      setTypes(next);
      toast('Document type deleted', { type: 'success' });
    } catch {
      toast('Failed to delete type', { type: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
      <div className="p-6 border-b border-edge">
        <h2 className="text-lg font-bold text-ink flex items-center gap-2">
          <Tag size={20} className="text-accent-600" /> Document Types
        </h2>
        <p className="text-sm text-ink-soft mt-1">
          Custom types available in the upload popup, the Documents page type filter, and a direct upload's "Change type" action. Built-in types (Invoice, RFI, Punch Report, etc.) are fixed and don't appear here.
        </p>
      </div>
      <div className="p-6 space-y-4">
        {loading ? (
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-600" />
        ) : types.length === 0 ? (
          <p className="text-sm text-ink-soft">No custom types yet.</p>
        ) : (
          <ul className="space-y-2">
            {types.map(t => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border border-edge px-4 py-2.5">
                {editingId === t.id ? (
                  <>
                    <Input
                      value={editLabel}
                      onChange={e => setEditLabel(e.target.value)}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') saveRename(t.id); if (e.key === 'Escape') cancelRename(); }}
                    />
                    <button onClick={() => saveRename(t.id)} disabled={busyId === t.id || !editLabel.trim()}
                      className="shrink-0 text-sm font-medium text-accent-600 hover:text-accent-700 disabled:opacity-50">
                      {busyId === t.id ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={cancelRename} title="Cancel"
                      className="shrink-0 p-1.5 rounded-md text-ink-faint hover:text-ink-soft hover:bg-hover">
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{t.label}</span>
                    <span className="shrink-0 font-mono text-xs text-ink-faint">custom:{t.id}</span>
                    <button onClick={() => startRename(t)} title="Rename"
                      className="shrink-0 p-1.5 rounded-md text-ink-faint hover:text-ink-soft hover:bg-hover">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(t)} disabled={busyId === t.id} title="Delete"
                      className="shrink-0 p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50">
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 border-t border-edge pt-4">
          <Input
            placeholder="e.g. Warranty"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          />
          <button onClick={handleAdd} disabled={adding || !newLabel.trim()}
            className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50">
            <Plus size={15} /> Add
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

// Kept as a value so a ?tab= param can be validated against it before it is
// trusted to select a tab.
const TAB_IDS = [
  'preferences', 'takeoff-templates', 'general', 'mail', 'storage', 'backup', 'document-editor', 'document-templates', 'users', 'aia-template', 'changelog',
] as const;
type TabId = (typeof TAB_IDS)[number];
const isTabId = (v: string | null): v is TabId => !!v && (TAB_IDS as readonly string[]).includes(v);
// Kept alongside TAB_IDS so the two-way ?tab= derivation below can validate
// an admin-only tab without waiting on the tabs array built later in render.
const ADMIN_ONLY_TAB_IDS = new Set<TabId>(['general', 'storage', 'backup', 'document-editor', 'document-templates', 'aia-template', 'users']);

export const Settings: React.FC = () => {
  const { toast } = useToast();
  const [serverSettings, setServerSettings] = useState<Record<string, string>>({
    appName: 'FrugalOmnibuild',
    logoUrl: '',
    companyName: '',
    companyLegalName: '',
    companyEntityType: '',
    companyStateOfFormation: '',
    companyPhone: '',
    companyEmail: '',
    companyAddress: '',
    companyBrandColor: '#99CB38',
    invertLogoOnDocuments: 'false',
    publicHost: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // Two-way ?tab= persistence (CustomerPane.tsx pattern): activeTab is derived
  // from the URL instead of mirrored into state, so a reload or the back
  // button lands back on the same tab. An invalid/missing param, or one
  // naming an admin-only tab while not an admin, falls back to the default.
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isTabId(tabParam) && (!ADMIN_ONLY_TAB_IDS.has(tabParam) || isAdmin)
    ? tabParam
    : 'preferences';
  const setActiveTab = (tab: TabId) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  // The mail OAuth callback lands here as `/settings?tab=mail&connected=<id>`
  // or `&error=<message>` (server/mail/routes.ts). Read once on mount: the
  // result is a toast, so re-running it on every param change would repeat it,
  // and `connected`/`error` are cleared straight afterwards so a reload — or a
  // shared URL — never replays a stale outcome.
  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');
    if (connected) toast('Mail account connected', { type: 'success' });
    if (error) toast(error, { type: 'error' });
    if (connected || error) {
      const next = new URLSearchParams(searchParams);
      next.delete('connected');
      next.delete('error');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        setIsAdmin(user.role === 'admin');
      }
    } catch { /* ignore */ }

    const fetchSettings = async () => {
      try {
        const data = await getSettings();
        setServerSettings(prev => ({ ...prev, ...data }));
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveSettings(serverSettings);
      if (serverSettings.appName) document.title = serverSettings.appName;
      toast('Settings saved successfully', { type: 'success' });
    } catch {
      toast('Failed to save settings', { type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setServerSettings(prev => ({ ...prev, logoUrl: reader.result as string }));
      reader.readAsDataURL(file);
    }
  };

  // Admin-only tabs not shown to regular users
  const allTabs: { id: TabId; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { id: 'preferences', label: 'User Preferences', icon: <User size={18} /> },
    { id: 'takeoff-templates', label: 'Takeoff Templates', icon: <Layout size={18} /> },
    { id: 'general',     label: 'General Settings', icon: <Globe size={18} />,   adminOnly: true },
    { id: 'mail',        label: 'Mail',              icon: <Mail size={18} /> },
    { id: 'storage',     label: 'Storage',           icon: <HardDrive size={18} />, adminOnly: true },
    { id: 'backup',      label: 'Backup',            icon: <DatabaseBackup size={18} />, adminOnly: true },
    { id: 'document-editor', label: 'Document Editor', icon: <FileText size={18} />, adminOnly: true },
    { id: 'document-templates', label: 'Document Templates', icon: <FilePlus2 size={18} />, adminOnly: true },
    { id: 'aia-template', label: 'AIA Template',     icon: <FileSpreadsheet size={18} />, adminOnly: true },
    { id: 'users',       label: 'User Management',  icon: <Users size={18} />,   adminOnly: true },
    { id: 'changelog',   label: 'Changelog',         icon: <History size={18} /> },
  ];
  const tabs = allTabs.filter(t => !t.adminOnly || isAdmin);

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" />
      </div>
    );
  }

  return (
    <div>
      <header className="bg-raised border-b border-edge sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-bold text-ink flex items-center gap-2">
              <Palette className="text-accent-600" size={24} />
              Settings
            </h1>
            {activeTab === 'general' && isAdmin && (
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2 bg-accent-600 text-white rounded-lg font-medium hover:bg-accent-700 transition-all disabled:opacity-50 shadow-sm"
              >
                <Save size={18} />
                {isSaving ? 'Saving…' : 'Save Changes'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Sidebar */}
          <aside className="w-full md:w-64 shrink-0">
            <nav className="flex overflow-x-auto no-scrollbar gap-1 md:flex-col md:overflow-visible md:space-y-1 md:gap-0">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all whitespace-nowrap shrink-0 md:w-full ${
                    activeTab === tab.id
                      ? 'glow-accent text-white'
                      : 'text-ink-soft hover:bg-hover hover:text-ink'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1">
          <div key={activeTab} className="anim-tab-in">
            {activeTab === 'preferences' && <PreferencesTab />}

            {activeTab === 'takeoff-templates' && <TemplatesView />}

            {activeTab === 'general' && isAdmin && (
              <div className="space-y-6">
                <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-edge">
                    <h2 className="text-lg font-bold text-ink">Application Branding</h2>
                    <p className="text-sm text-ink-soft">Customize how the application appears to users.</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <Field label="Application Name" hint="Updates the name shown in the navigation bar and browser tab title.">
                      <Input type="text" value={serverSettings.appName}
                        onChange={e => setServerSettings({ ...serverSettings, appName: e.target.value })}
                        placeholder="e.g. My Custom Takeoff" />
                    </Field>
                    <div>
                      <label className="block text-sm font-bold text-ink mb-2 uppercase tracking-wider">Application Logo</label>
                      <div className="flex items-start gap-6">
                        <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-edge bg-sunken flex items-center justify-center overflow-hidden shrink-0">
                          {serverSettings.logoUrl
                            ? <img src={serverSettings.logoUrl} alt="Logo Preview" className="max-w-full max-h-full object-contain" />
                            : <ImageIcon className="text-ink-faint" size={32} />}
                        </div>
                        <div className="flex-1">
                          <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" id="logo-upload" />
                          <label htmlFor="logo-upload"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-raised border border-edge rounded-lg text-sm font-medium text-ink hover:bg-hover cursor-pointer transition-all shadow-sm">
                            <ImageIcon size={16} /> Upload New Logo
                          </label>
                          {serverSettings.logoUrl && (
                            <button onClick={() => setServerSettings({ ...serverSettings, logoUrl: '' })}
                              className="ml-3 text-sm text-red-500 hover:text-red-600 font-medium">
                              Remove
                            </button>
                          )}
                          <p className="mt-2 text-xs text-ink-soft">
                            Recommended: Square or horizontal logo, transparent background. Max 2MB.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-edge">
                    <h2 className="text-lg font-bold text-ink">Company legal details</h2>
                    <p className="text-sm text-ink-soft">Printed on lien releases (the lienor and the notary sentence). Each release keeps its own copy, which you can change there.</p>
                  </div>
                  <div className="p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <Field label="Legal name" hint="Falls back to the company name when empty.">
                        <Input
                          value={serverSettings.companyLegalName || ''}
                          onChange={e => setServerSettings({ ...serverSettings, companyLegalName: e.target.value })}
                          placeholder="e.g. Acme Contracting, LLC"
                        />
                      </Field>
                      <Field label="Entity type">
                        <select
                          aria-label="Entity type"
                          value={serverSettings.companyEntityType || ''}
                          onChange={e => setServerSettings({ ...serverSettings, companyEntityType: e.target.value })}
                          className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink"
                        >
                          <option value="">Not set</option>
                          <option value="llc">LLC</option>
                          <option value="corporation">Corporation</option>
                          <option value="partnership">Partnership</option>
                          <option value="sole_proprietor">Sole proprietor</option>
                          <option value="other">Other</option>
                        </select>
                      </Field>
                      <Field label="State of formation">
                        <Input
                          value={serverSettings.companyStateOfFormation || ''}
                          onChange={e => setServerSettings({ ...serverSettings, companyStateOfFormation: e.target.value })}
                          placeholder="e.g. Florida"
                        />
                      </Field>
                    </div>
                  </div>
                </div>

                <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-edge">
                    <h2 className="text-lg font-bold text-ink">Contractor Information</h2>
                    <p className="text-sm text-ink-soft">Shown on proposal PDFs generated from projects.</p>
                  </div>
                  <div className="p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      {[
                        { key: 'companyName',    label: 'Company Name', type: 'text',  placeholder: 'e.g. Acme Contracting LLC' },
                        { key: 'companyPhone',   label: 'Phone',        type: 'tel',   placeholder: 'e.g. (555) 123-4567' },
                        { key: 'companyEmail',   label: 'Email',        type: 'email', placeholder: 'e.g. info@acme.com' },
                        { key: 'companyAddress', label: 'Address',      type: 'text',  placeholder: 'e.g. 123 Main St, Springfield, IL' },
                      ].map(field => (
                        <Field key={field.key} label={field.label}>
                          <Input
                            type={field.type}
                            value={serverSettings[field.key] || ''}
                            onChange={e => setServerSettings({ ...serverSettings, [field.key]: e.target.value })}
                            placeholder={field.placeholder}
                          />
                        </Field>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-edge">
                    <h2 className="text-lg font-bold text-ink">Document Branding</h2>
                    <p className="text-sm text-ink-soft">Controls the branded header and footer on generated documents (proposals, invoices, change orders, issues, punch lists).</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <div>
                      <label htmlFor="company-brand-color" className="block text-sm font-bold text-ink mb-2 uppercase tracking-wider">Document Brand Colour</label>
                      <div className="flex items-center gap-3">
                        <input
                          id="company-brand-color"
                          type="color"
                          value={serverSettings.companyBrandColor || '#99CB38'}
                          onChange={e => setServerSettings({ ...serverSettings, companyBrandColor: e.target.value })}
                          className="w-12 h-10 rounded-lg border border-edge-strong bg-transparent cursor-pointer shrink-0"
                          aria-describedby="company-brand-color-hint"
                        />
                        <span className="font-mono text-sm text-ink uppercase">
                          {serverSettings.companyBrandColor || '#99CB38'}
                        </span>
                      </div>
                      <p id="company-brand-color-hint" className="mt-2 text-xs text-ink-soft italic">
                        Used for the header/footer accents on generated documents (proposals, invoices, etc.).
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-ink">Invert Logo on Documents</p>
                        <p id="invert-logo-hint" className="text-xs text-ink-soft mt-0.5">
                          Turn on if your logo is dark — it will be shown in white on the dark document header.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={serverSettings.invertLogoOnDocuments === 'true'}
                        aria-label="Invert logo on documents"
                        aria-describedby="invert-logo-hint"
                        onClick={() => setServerSettings({ ...serverSettings, invertLogoOnDocuments: serverSettings.invertLogoOnDocuments === 'true' ? 'false' : 'true' })}
                        className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised ${serverSettings.invertLogoOnDocuments === 'true' ? 'bg-accent-600' : 'bg-edge-strong'}`}
                      >
                        <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                          className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${serverSettings.invertLogoOnDocuments === 'true' ? 'left-6' : 'left-0.5'}`} />
                      </button>
                    </div>
                  </div>
                </div>

                <DocumentTypesCard />

                <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-edge">
                    <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                      <Link size={20} className="text-accent-600" /> Sharing
                    </h2>
                    <p className="text-sm text-ink-soft">Configure the public URL used when generating share links for printouts and project pages.</p>
                  </div>
                  <div className="p-6">
                    <Field label="Public Host URL">
                      <Input
                        type="url"
                        value={serverSettings.publicHost || ''}
                        onChange={e => setServerSettings({ ...serverSettings, publicHost: e.target.value })}
                        placeholder="e.g. https://takeoff.mydomain.com"
                      />
                    </Field>
                    <p className="mt-2 text-xs text-ink-soft">
                      Used to build share links (e.g. <span className="font-mono">https://takeoff.mydomain.com/share/…</span>). If left blank, the app's current origin is used instead.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'mail' && <MailAccountsTab isAdmin={isAdmin} />}

            {activeTab === 'storage' && isAdmin && <StorageTab />}

            {activeTab === 'backup' && isAdmin && <BackupTab />}

            {activeTab === 'document-editor' && isAdmin && <DocumentEditorTab />}

            {activeTab === 'document-templates' && isAdmin && <DocumentTemplatesTab />}

            {activeTab === 'aia-template' && isAdmin && <AiaTemplateTab />}

            {activeTab === 'users' && isAdmin && (
              <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden p-6">
                <UsersView />
              </div>
            )}

            {activeTab === 'changelog' && <ChangelogTab />}
          </div>
          </div>
        </div>
      </main>
    </div>
  );
};
