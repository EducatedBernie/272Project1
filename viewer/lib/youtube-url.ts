const YOUTUBE_HOST_RE = /(^|\.)youtube\.com$/i;
const YOUTUBE_NOCOOKIE_HOST_RE = /(^|\.)youtube-nocookie\.com$/i;

function firstPathSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment || null;
}

function cleanVideoId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim().split(/[?&#/]/)[0];
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

export function extractYouTubeId(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be") {
      return cleanVideoId(firstPathSegment(url.pathname));
    }

    if (YOUTUBE_HOST_RE.test(host) || YOUTUBE_NOCOOKIE_HOST_RE.test(host)) {
      if (url.pathname === "/watch") {
        return cleanVideoId(url.searchParams.get("v"));
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live", "v"].includes(parts[0])) {
        return cleanVideoId(parts[1]);
      }
    }

    return null;
  } catch {
    // Fall through to regex support for schemeless or loosely pasted URLs.
  }

  const patterns = [
    /(?:^|https?:\/\/)(?:www\.)?youtu\.be\/([^?&#/\s]+)/i,
    /(?:^|https?:\/\/)(?:[A-Za-z0-9-]+\.)*youtube(?:-nocookie)?\.com\/watch\?(?:[^#\s&]*&)*v=([^?&#/\s]+)/i,
    /(?:^|https?:\/\/)(?:[A-Za-z0-9-]+\.)*youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/([^?&#/\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const id = cleanVideoId(match?.[1]);
    if (id) return id;
  }
  return null;
}

export function canonicalizeYouTubeUrl(input: string): string | null {
  const id = extractYouTubeId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function canonicalizeYouTubeUrlIfPossible(input: string): string {
  return canonicalizeYouTubeUrl(input) ?? input;
}
