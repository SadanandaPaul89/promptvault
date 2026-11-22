// Maps any Instagram / LinkedIn post URL to one stable cache key, so the same
// post shared via different links (tracking params, /reel vs /reels, profile-
// prefixed paths, feed URNs vs vanity /posts/ slugs) hits the same analysis.
// Pure — no network. Short links (lnkd.in, instagr.am) are not resolved: the
// extension always sends the full URL from the tab.

export type Platform = "instagram" | "linkedin";
export type Canonical = { platform: Platform; key: string; url: string };

const IG_HOST = /(^|\.)instagram\.com$/i;
const LI_HOST = /(^|\.)linkedin\.com$/i;
const IG_CODE = /^[A-Za-z0-9_-]{5,40}$/;
const IG_KINDS = new Set(["p", "reel", "reels", "tv"]);

export function canonicalize(raw: string): Canonical | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  if (IG_HOST.test(u.hostname)) {
    // /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}, or /{user}/p/{code}, /{user}/reel/{code}
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = 0; i < Math.min(segs.length - 1, 2); i++) {
      const kind = segs[i]!.toLowerCase();
      const code = segs[i + 1]!;
      if (IG_KINDS.has(kind) && IG_CODE.test(code)) {
        const path = kind === "p" ? "p" : "reel";
        return { platform: "instagram", key: `ig:${code}`, url: `https://www.instagram.com/${path}/${code}/` };
      }
    }
    return null;
  }

  if (LI_HOST.test(u.hostname)) {
    let path: string;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      path = u.pathname;
    }
    // /feed/update/urn:li:activity:123…  (also ugcPost / share URNs)
    const urn = path.match(/urn:li:(activity|ugcPost|share):(\d{8,25})/);
    // /posts/{author}_{slug}-activity-123…-abcd
    const vanity = path.match(/\/posts\/[^/]*-(activity|ugcPost|share)-(\d{8,25})(?:-|\/|$)/);
    const m = urn ?? vanity;
    if (m) {
      const type = m[1]!;
      const id = m[2]!;
      return { platform: "linkedin", key: `li:${type}:${id}`, url: `https://www.linkedin.com/feed/update/urn:li:${type}:${id}/` };
    }
    return null;
  }

  return null;
}
