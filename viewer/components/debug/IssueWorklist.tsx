"use client";

import { useEffect, useRef } from "react";

import ArtifactRow from "./IssueRow";
import type { VisualContent } from "@/lib/types";

interface Props {
  items: VisualContent[];
  selectedId: string | null;
  currentTime: number;
  onSelect: (id: string) => void;
}

export default function ArtifactWorklist({ items, selectedId, currentTime, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Scroll the selected row into view (~1/3 from the top) when selection
  // changes — typically because the user clicked a timeline dot or
  // jumped in via ?t= deeplink.
  useEffect(() => {
    if (!selectedId) return;
    const container = scrollRef.current;
    const el = activeRef.current;
    if (!container || !el) return;
    const elTop = el.offsetTop - container.offsetTop;
    const target = elTop - container.clientHeight / 3;
    if (Math.abs(container.scrollTop - target) > 40) {
      container.scrollTo({ top: target, behavior: "smooth" });
    }
  }, [selectedId]);

  if (items.length === 0) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-6 text-sm italic text-center"
        style={{ color: "var(--muted-fg)" }}
      >
        No visual content matches the current filter.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      {items.map((item) => {
        const selected = item.id === selectedId;
        const active = currentTime >= item.start && currentTime <= item.end;
        return (
          <div key={item.id} ref={selected ? activeRef : null}>
            <ArtifactRow
              item={item}
              selected={selected}
              active={active}
              onSelect={onSelect}
            />
          </div>
        );
      })}
    </div>
  );
}
