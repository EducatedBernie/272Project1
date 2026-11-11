"use client";

import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query.
 *
 * SSR/hydration: returns `false` on initial render (server + client first paint),
 * then updates after `useEffect` runs. Callers that branch on this hook get the
 * non-matching layout on first paint, which prevents hydration mismatch but
 * causes a brief flash on the matching viewport. For viewer chrome that's fine;
 * don't use this in code where the flash is user-visible critical state.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * True when viewport is below Tailwind's `md` breakpoint (768px).
 * Defaults to false on SSR + first paint — see `useMediaQuery` doc.
 */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
