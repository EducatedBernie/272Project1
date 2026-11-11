"use client";

import { useRef } from "react";

interface Tab<K extends string> {
  key: K;
  label: string;
  count?: number;
}

interface MobileTabBarProps<K extends string> {
  tabs: Tab<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}

export default function MobileTabBar<K extends string>({
  tabs,
  active,
  onChange,
  className = "",
}: MobileTabBarProps<K>) {
  const refs = useRef<Map<K, HTMLButtonElement>>(new Map());

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const idx = tabs.findIndex((t) => t.key === active);
    let nextIdx = idx;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    else return;
    e.preventDefault();
    const nextKey = tabs[nextIdx].key;
    onChange(nextKey);
    refs.current.get(nextKey)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="View"
      className={`shrink-0 flex md:hidden items-stretch gap-1 px-2 pt-2 ${className}`}
      style={{
        background: "var(--card)",
        borderTop: "1px solid var(--border)",
        paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            aria-controls={`mobile-panel-${tab.key}`}
            id={`mobile-tab-${tab.key}`}
            tabIndex={isActive ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(tab.key, el);
              else refs.current.delete(tab.key);
            }}
            onClick={() => onChange(tab.key)}
            onKeyDown={handleKeyDown}
            className="flex-1 min-w-0 rounded-lg px-3 text-[13px] font-semibold transition-colors flex items-center justify-center gap-1.5"
            style={{
              minHeight: 44,
              background: isActive ? "var(--background)" : "transparent",
              color: isActive ? "var(--foreground)" : "var(--muted-fg)",
              boxShadow: isActive
                ? "0 1px 2px rgba(0,0,0,0.06), 0 0 0 1px var(--border)"
                : "none",
            }}
          >
            <span>{tab.label}</span>
            {typeof tab.count === "number" && (
              <span
                className="text-[11px] font-mono"
                style={{ color: "var(--muted-fg)", opacity: 0.8 }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
