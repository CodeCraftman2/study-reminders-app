# Study Reminders (phone app)

Upload a study plan (PDF, CSV or Excel). The app finds each day's tasks, schedules phone notifications for them,
and tracks your progress. Your phone delivers the notifications even when the app is closed.

## Install the app (Android)
Download the APK from the Expo build page, open it on your phone and install it.
Android may ask you to allow "Install unknown apps" for your browser. No PC or Expo Go is needed after that.

## Run it from this folder (for changes)
1. `npm install` (first time only)
2. `npx.cmd expo start`. Use `npx.cmd` in Windows PowerShell; plain `npx` may be blocked by its script policy.
3. Scan the QR code with Expo Go on your phone (same Wi-Fi as the PC).

## Build a new APK
`npx.cmd eas-cli build -p android --profile preview`
This needs the Expo account the project is linked to (see `owner` in `app.json`).

## What it does
- Reads any file with a "Date" column (or lines that start with a date), plus one column per task type.
- Default time per task type, editable per task; morning overview; heads-up 5–60 min before each task.
- Tick tasks as done: finished tasks stop sending reminders. The Progress tab shows a gauge, streak,
  calendar, exam countdown and per-subject / per-phase progress.
- Auto / Light / Dark theme. Design: dark-green glow, lime accent, Inter type, Lucide line icons.
- iPhone allows only 64 pending notifications per app, so the app schedules the next batch and refills it whenever you open it.

## Files
- `App.js`: main screen (Plan tab, top bar, bottom bar, time picker)
- `src/Dashboard.js`: Progress tab
- `src/parse.js`: reading Excel / CSV / PDF tables, building reminders, progress maths
- `src/scheduler.js`: phone notifications
- `src/theme.js`, `src/Glass.js`, `src/Icons.js`: colours, fonts, surfaces, icons
- `test/parse.test.mjs`: `node test/parse.test.mjs <plan.xlsx> [plan.csv]`
