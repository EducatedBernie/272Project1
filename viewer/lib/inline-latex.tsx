"use client";

import { useEffect, useRef } from "react";
import katex from "@/lib/katex";
import { parseInlineLatex } from "@/lib/parse-inline-latex";
export { parseInlineLatex } from "@/lib/parse-inline-latex";

export function InlineLatex({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(latex, ref.current, {
        throwOnError: false,
        displayMode: false,
        output: "htmlAndMathml",
      });
    } catch {
      if (ref.current) ref.current.textContent = `$${latex}$`;
    }
  }, [latex]);

  return <span ref={ref} className="mx-0.5" role="math" />;
}

export function DisplayLatex({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(latex, ref.current, {
        throwOnError: false,
        displayMode: true,
        output: "htmlAndMathml",
      });
    } catch {
      if (ref.current) ref.current.textContent = latex;
    }
  }, [latex]);

  return <span ref={ref} className="block" role="math" />;
}

export function SegmentText({ text }: { text: string }) {
  const parts = parseInlineLatex(text);

  return (
    <span>
      {parts.map((part, i) =>
        part.type === "latex" ? (
          <InlineLatex key={i} latex={part.content} />
        ) : (
          <span key={i}>{part.content}</span>
        )
      )}
    </span>
  );
}
