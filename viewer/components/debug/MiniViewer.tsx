/**
 * Draggable + resizable picture-in-picture player for the /debug page.
 *
 * Controlled component — DebugView owns the rect (x, y, width, height)
 * and persistence; MiniViewer just renders + emits drag/resize updates.
 *
 *   • Top strip is the drag handle. Time chip on the left, reset button
 *     on the right, cursor: grab.
 *   • Bottom-right corner is the resize handle. Cursor: nwse-resize.
 *   • While dragging or resizing, a transparent capture overlay sits
 *     above the iframe / <video>, so window-level mousemove keeps
 *     firing even when the cursor passes over YouTube's nested
 *     document. Overlay disappears on mouseup, restoring native
 *     player controls.
 *   • Touch events mirror mouse events for laptop trackpads / iPad.
 *   • Single mount preserved — only style values change with state.
 */

"use client";

import {
  type Ref,
  type RefObject,
  forwardRef,
  useCallback,
  useEffect,
  useState,
} from "react";

import VideoPlayer, { type PlayerHandle } from "../VideoPlayer";
import type { VideoSource } from "@/lib/types";
import { formatTime } from "@/lib/debug-utils";

export interface MiniRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props {
  source: VideoSource;
  rect: MiniRect;
  onRectChange: (next: MiniRect) => void;
  onReset: () => void;
  onTimeUpdate: (time: number) => void;
  currentTime: number;
  startAt?: number;
}

export const MIN_WIDTH = 160;
export const MIN_HEIGHT = 90;
const DRAG_HANDLE_HEIGHT = 24;

interface DragState {
  kind: "drag" | "resize";
  startPointer: { x: number; y: number };
  startRect: MiniRect;
  /** Live cursor delta from the start pointer; updated each mousemove. */
  delta: { dx: number; dy: number };
}

function applyDelta(state: DragState): MiniRect {
  const { startRect, delta, kind } = state;
  if (kind === "drag") {
    return {
      ...startRect,
      x: startRect.x + delta.dx,
      y: startRect.y + delta.dy,
    };
  }
  return {
    ...startRect,
    width: Math.max(MIN_WIDTH, startRect.width + delta.dx),
    height: Math.max(MIN_HEIGHT, startRect.height + delta.dy),
  };
}

const MiniViewer = forwardRef(function MiniViewer(
  { source, rect, onRectChange, onReset, onTimeUpdate, currentTime, startAt }: Props,
  ref: Ref<PlayerHandle>,
) {
  // Single source of truth for live rect: when idle, render parent's
  // `rect`; while interacting, render `applyDelta(drag)`. No sync effect
  // needed — `displayRect` is derived per render.
  const [drag, setDrag] = useState<DragState | null>(null);
  const displayRect = drag ? applyDelta(drag) : rect;

  const startInteraction = useCallback(
    (kind: "drag" | "resize", clientX: number, clientY: number) => {
      setDrag({
        kind,
        startPointer: { x: clientX, y: clientY },
        startRect: rect,
        delta: { dx: 0, dy: 0 },
      });
    },
    [rect],
  );

  // Mouse + touch listeners while dragging or resizing. Bound at the
  // window level so events still arrive when the cursor passes over the
  // (overlay-shielded) iframe.
  useEffect(() => {
    if (!drag) return;

    const onMove = (clientX: number, clientY: number) => {
      setDrag((prev) =>
        prev
          ? {
              ...prev,
              delta: {
                dx: clientX - prev.startPointer.x,
                dy: clientY - prev.startPointer.y,
              },
            }
          : prev,
      );
    };
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        e.preventDefault();
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const finish = () => {
      setDrag((prev) => {
        if (prev) onRectChange(applyDelta(prev));
        return null;
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finish);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", finish);
    window.addEventListener("touchcancel", finish);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", finish);
      window.removeEventListener("touchcancel", finish);
    };
  }, [drag, onRectChange]);

  const dragging = drag?.kind === "drag";
  const resizing = drag?.kind === "resize";

  return (
    <div
      className="flex flex-col"
      style={{
        position: "fixed",
        left: displayRect.x,
        top: displayRect.y,
        width: displayRect.width,
        height: displayRect.height,
        background: "#000",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        overflow: "hidden",
        zIndex: 50,
      }}
    >
      {/* Drag handle — top strip */}
      <div
        className="flex items-center justify-between px-2 select-none shrink-0"
        style={{
          height: DRAG_HANDLE_HEIGHT,
          background: "rgba(0,0,0,0.85)",
          color: "#fff",
          cursor: dragging ? "grabbing" : "grab",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          startInteraction("drag", e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if (e.touches.length > 0) {
            startInteraction("drag", e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
      >
        <span
          className="text-[11px] font-mono"
          style={{ color: "rgba(255,255,255,0.85)" }}
        >
          {formatTime(currentTime)}
        </span>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onReset();
          }}
          className="text-[11px] font-mono px-1.5 rounded"
          style={{
            background: "rgba(255,255,255,0.12)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
          aria-label="Reset player position and size"
          title="Reset player position and size"
        >
          ↺
        </button>
      </div>

      {/* Player content */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <VideoPlayer
          ref={ref as RefObject<PlayerHandle>}
          source={source}
          onTimeUpdate={onTimeUpdate}
          startAt={startAt}
        />

        {/* Capture overlay — only while interacting. Lets window-level
            mousemove receive events even when the cursor is over the
            iframe/video element. */}
        {(dragging || resizing) && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              cursor: dragging ? "grabbing" : "nwse-resize",
              background: "transparent",
              zIndex: 1,
            }}
          />
        )}
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          startInteraction("resize", e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if (e.touches.length > 0) {
            e.stopPropagation();
            startInteraction("resize", e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
        aria-label="Resize player"
        title="Drag to resize"
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
          cursor: "nwse-resize",
          background:
            "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.6) 50%)",
          zIndex: 2,
        }}
      />
    </div>
  );
});

export default MiniViewer;
