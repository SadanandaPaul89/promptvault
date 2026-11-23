import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The extension isn't on the Chrome Web Store yet, so it's installed from a zip
// the build puts next to the site (scripts/build-extension.mjs) via "Load unpacked".
export const EXTENSION_ZIP = "/promptvault-extension.zip";
const FOLDER = "promptvault-extension";

type Browser = { ok: boolean; name: string; page: string };

function detectBrowser(): Browser {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobi/i.test(ua);
  if (mobile) return { ok: false, name: "phone", page: "chrome://extensions" };
  if (/Edg\//.test(ua)) return { ok: true, name: "Edge", page: "edge://extensions" };
  if (/OPR\//.test(ua)) return { ok: true, name: "Opera", page: "opera://extensions" };
  if (/Chrome\//.test(ua)) return { ok: true, name: "Chrome", page: "chrome://extensions" };
  return { ok: false, name: /Firefox\//.test(ua) ? "Firefox" : "this browser", page: "chrome://extensions" };
}

/** Header / panel button that opens the install guide. */
export function InstallExtensionButton({ className = "btn btn-secondary", label = "Install extension" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2.5h16V17" />
        </svg>
        {label}
      </button>
      {open && <InstallDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function InstallDialog({ onClose }: { onClose: () => void }) {
  const browser = useState(detectBrowser)[0];
  const [copied, setCopied] = useState(false);
  const first = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Web pages can't open chrome:// links, so the address is copied for pasting.
  const copyPage = async () => {
    try { await navigator.clipboard.writeText(browser.page); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* user can type it */ }
  };

  // Portal to <body>: the sticky header's backdrop-filter would otherwise become the
  // containing block for this fixed overlay and clip it to the header's height.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="ext-title" className="modal modal-wide">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="ext-title" className="font-display text-xl font-bold">Install the PromptVault extension</h2>
            <p className="text-sm text-[var(--dim)] mt-1">Finds the prompt in an Instagram reel or post, or a LinkedIn post. It only reads a page when you press Analyze.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-2 -mt-1">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        {!browser.ok && (
          <p role="note" className="callout mt-4 text-sm">
            {browser.name === "phone"
              ? "The extension works on a computer, in Chrome, Edge or Brave. The mobile app is coming soon."
              : `The extension doesn't run in ${browser.name}. Open this page in Chrome, Edge or Brave on a computer.`}
          </p>
        )}

        <ol className="steps mt-5">
          <li>
            <span>
              <a ref={first} href={EXTENSION_ZIP} download className="btn btn-primary btn-sm">Download the extension (.zip)</a>
            </span>
          </li>
          <li><span><b>Unzip it.</b> On Windows: right-click → Extract All. On a Mac: double-click. You get a folder named <code>{FOLDER}</code>. Keep it somewhere it won't be deleted; the browser loads the extension from it.</span></li>
          <li>
            <span>
              Open a new tab and go to <code>{browser.page}</code>{" "}
              <button type="button" className="link text-xs" onClick={copyPage}>{copied ? "Copied" : "Copy address"}</button>
            </span>
          </li>
          <li><span>Turn on <b>Developer mode</b> (switch at the top right{browser.name === "Edge" ? ", or bottom left in Edge" : ""}).</span></li>
          <li><span>Click <b>Load unpacked</b> and select the <code>{FOLDER}</code> folder.</span></li>
          <li><span>Pin it: click the puzzle-piece icon in the toolbar, then the pin next to <b>PromptVault</b>. Open a reel, click the icon and press <b>Analyze this post</b>.</span></li>
        </ol>

        <p className="text-xs text-[var(--dim)] mt-5 pt-4 border-t border-[var(--border)]">
          One-click install from the Chrome Web Store is coming soon. To update until then, download again, replace the folder's contents, and press the reload icon on the extension's card.
        </p>
      </div>
    </div>,
    document.body,
  );
}
