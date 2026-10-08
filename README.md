# Pagepress

A local website that captures the rendered pages of Google Drive PDFs and assembles image-based PDFs. Use only for documents you own or have the owner's permission to copy. Pagepress does not grant access to private documents, bypass Google sign-in, or remove document watermarks.

## Start

Requires Node.js 20+ and Google Chrome or Microsoft Edge. All project code is in this folder.

```powershell
npm install
npm start
```

Open the localhost URL printed in the terminal, normally http://127.0.0.1:4310. If the port is busy, the app tries the next nine ports. On Windows, `start.cmd` installs dependencies if needed and starts the app. Stop the server with Ctrl+C.

## Capture a PDF

1. Click **Sign in to Google**. Ordinary Chrome opens using Pagepress's dedicated profile, with no remote-debugging or automation flags. Sign in directly in that window, then **close that Chrome window normally** to save the session. Keep the Pagepress website open. Your normal Chrome and VS Code Google sessions are not copied.
2. Paste one or more individual Google Drive file links, one per line. Folder links are not supported. Pagepress opens a separate capture window using the same saved profile after the sign-in window closes.
3. Choose standard (1600-pixel target) or high (3200-pixel target) resolution. Every capture includes all pages; there is no page-selection setting. Old page-range values are ignored when jobs are submitted, resumed or retried.
4. Confirm permission and click **Capture PDF**. If Google requests sign-in, Pagepress closes the automated capture window and opens ordinary Chrome for you. Finish signing in there and close that window normally. Capture resumes automatically; no Continue click is required. Queued jobs start in order after the active job finishes.
5. Keep the Pagepress website open and the capture window visible. Drive loads pages as they scroll into view. The rows show queue position, the reason for any wait, pages captured and percentage progress. **Cancel** stops a queued or active capture.
6. **Download automatically when ready** is enabled by default. The completed PDF starts downloading in the browser that has Pagepress open. Allow automatic/multiple downloads if Chrome prompts. A labeled **Download** button remains available if the browser blocks the automatic request. Turn off the checkbox for manual downloads only.

**Try sample** performs a complete three-page capture locally without Google or a login. The sample document and previews contain no real customer data.

The library supports progress, cancellation, retry, previews, search and deletion. Pending/awaiting-sign-in jobs resume after a server restart. A capture interrupted while processing pages is marked interrupted and can be retried. Automatic download requests are tracked per browser tab across refreshes to avoid repeating completed downloads. Keep the tab open during capture; downloads blocked by browser policy can be started with the Download button. Deleting a capture removes the app's copy, not files you already downloaded separately.

### Google says the browser may not be secure

Do not repeatedly retry in an automated capture window. Use **Sign in to Google** and complete sign-in in the ordinary, non-debugged Chrome window instead. Close it normally and capture resumes automatically; a browser profile cannot be used by both sessions at once. Pagepress does not monitor credentials or attach automation while you are signing in, so signing in without closing that window leaves capture waiting. Cancelling a capture or stopping Pagepress does not force-close a manual sign-in window.

This separates authentication from browser automation; it does not disable Google's protections or guarantee acceptance. If Google still rejects ordinary Chrome, update Chrome and follow Google's account/security guidance. Organization restrictions or missing file permissions must be resolved with the account administrator or file owner.

## Local data and privacy

- The server binds only to `127.0.0.1`. There is no hosted backend and no cloud upload by Pagepress. The capture browser communicates with Google to display your files.
- On Windows, private exports, previews, job metadata and the dedicated Chrome profile live in `%LOCALAPPDATA%\Pagepress\<project-id>`. They are outside this OneDrive workspace by default. The full location is printed on startup.
- Do not upload or share that data directory: it includes sensitive document copies and an authenticated browser profile. The HTTP API is local-only, not an authenticated multi-user service; other processes/users on the same machine may be able to access it. Use a trusted computer.
- Mutating API requests require a per-server token. Cross-site requests and non-local Host headers are rejected. User-supplied links are restricted to actual HTTPS Google Drive file links; arbitrary URL fetching is not exposed.
- To sign out, click **Sign in to Google** when no capture is running and use Google's account controls in ordinary Chrome. **Close capture browser** closes only the automated browser, gracefully, and retains its login for next time. Close the manual sign-in window with its own close button. Never enter Google passwords into the Pagepress website.
- To remove all app data, stop Pagepress, close the capture browser and delete the printed data directory. Move/backup the app's data explicitly if relocating the project; its default project ID is derived from the folder path.

## Limits and scope

- Output is a raster/image-based PDF, not the original PDF. Text selection, links, original annotations and accessibility metadata are not preserved. No OCR is performed.
- A maximum of 10 links per submission, 500 pages per document, 200 MB of captured PNG data and 100 saved jobs is enforced. Documents over these limits fail with a clear error; pages are never silently omitted. Delete old jobs if the library is full, or use standard resolution for high-memory documents.
- Drive's private viewer structure can change. If it cannot expose loaded page images safely, the job stops instead of producing an incomplete document. Pages below the requested resolution are flagged.
- Google may reject sign-in from a managed or automated browser. Complete Google's normal verification; Pagepress does not bypass account security. Organization restrictions, owner permissions or missing access must be resolved with the owner/administrator.
- Only the first captured page is kept as a preview. The downloaded PDF contains every document page in ascending order, with its aspect ratio preserved. Existing partial PDFs from older captures are unchanged; submit their link again to create a complete PDF.
- PDF assembly temporarily uses RAM. High-resolution, long documents may require substantial memory. Use standard resolution on low-memory machines.
- Run only one instance of Pagepress for a given data directory. This is a local personal tool, not a public web service.

## Configuration

```powershell
$env:PORT = '4400'
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:PAGEPRESS_DATA_DIR = 'C:\LocalApps\PagepressData'
npm start
```

If Chrome/Edge is unavailable, `npx playwright install chromium` installs a supported browser. macOS and Linux Chrome paths are also detected. GUI access is required for private Drive sign-in; the sample runs headlessly.

## Checks

```powershell
npm test
```

Tests cover URL boundaries, complete-document capture (including ignored legacy ranges), filename safety, local API protections, consent, cancellation/persistence, non-automated sign-in arguments, graceful shutdown, automatic queue draining and the rejected-login handoff to a fresh capture tab. Real headless-browser tests capture every lazy-loaded sample page, automatically download the PDF, and exercise the page/percentage progress and labeled controls on desktop/mobile. Tests simulate the authentication screen; they do not sign in to Google or copy private files.

Core dependencies: Express, Playwright, pdf-lib, Lucide, and local Manrope/IBM Plex Mono fonts. No global browser flags, existing browser cookies or project files outside Pagepress are modified.