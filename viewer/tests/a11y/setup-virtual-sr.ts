import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

export interface VirtualScreenReader {
  start: (opts: { container: Element }) => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  stop: () => Promise<void>;
  spokenPhraseLog: () => Promise<string[]>;
  lastSpokenPhrase: () => Promise<string>;
}

declare global {
  interface Window {
    __virtualScreenReaderReady?: Promise<void>;
    virtual?: VirtualScreenReader;
  }
}

let scriptCache: string | null = null;

async function loadVirtualReaderScript(): Promise<string> {
  if (scriptCache) return scriptCache;
  const file = path.join(
    process.cwd(),
    "node_modules/@guidepup/virtual-screen-reader/lib/esm/index.browser.js"
  );
  scriptCache = await fs.readFile(file, "utf8");
  return scriptCache;
}

export async function attachVirtualReader(page: Page): Promise<void> {
  const script = await loadVirtualReaderScript();
  await page.addInitScript((moduleSource) => {
    window.__virtualScreenReaderReady = (async () => {
      const url = URL.createObjectURL(
        new Blob([moduleSource], { type: "text/javascript" })
      );
      try {
        const { virtual } = await import(url);
        window.virtual = virtual;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
  }, script);
}

export async function waitForVirtualReader(page: Page): Promise<void> {
  await page.evaluate(() => window.__virtualScreenReaderReady);
}
