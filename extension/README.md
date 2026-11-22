# PromptVault: Post Analyzer extension (Chrome, MV3)

## Load it for development
1. `npm install && npm run ext:vendor` from the repo root. This copies Tesseract.js OCR into `extension/vendor/`, because MV3 can't load code from a CDN.
2. Start the API with `npm run dev`. To turn on reel transcription, also set `WHISPER_BIN` and `WHISPER_MODEL`.
3. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select this folder.
4. Open an Instagram post or reel, or a LinkedIn post. Click the PromptVault toolbar icon, then click **Analyze this post**.

## How users install it (until it's on the Chrome Web Store)
`npm run build` / `build:vercel` runs `scripts/build-extension.mjs`, which packages this folder as `dist/promptvault-extension.zip` with the deployed API origin swapped into `config.js` and the manifest (`EXTENSION_API_BASE`, or `https://$VERCEL_PROJECT_PRODUCTION_URL` on Vercel). The site's **Install extension** button links to that zip and walks users through **Load unpacked**. Run `npm run ext:zip` to build just the zip.

## Files
| File | Role |
|---|---|
| `sidepanel.js` | The flow: cache check → read post → OCR → record reel → send |
| `page.js` | Injected into the tab on click. Finds the post being viewed (URL, text, creator, images, video) |
| `capture.js` | `tabCapture`: records reel audio and samples frames cropped to the video |
| `config.js` | API origin. Change it together with the `localhost` host permission in `manifest.json` |

## Before publishing
- Upload the zip that `npm run ext:zip` builds (with `EXTENSION_API_BASE` set). It already points at the production API.
- Add icons (`icons` in the manifest).
- Write a privacy policy that says media is processed and discarded, and only extracted text and the post link are stored.

## Known limits
- Instagram and LinkedIn change their markup often. `page.js` uses layered selectors and fallbacks, but expect to maintain it.
- LinkedIn document (PDF) carousels render in a cross-origin iframe and aren't read yet.
- Instagram carousels: only slides the page has already loaded are read with OCR. Swipe through the carousel first to include all of them.
- Reel recording requires the side panel to stay open while the reel plays (up to 90 s).
