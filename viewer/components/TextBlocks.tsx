import type { TextBlock } from "@/lib/types";
import { SegmentText as RichText } from "@/lib/inline-latex";

/**
 * Renders structured text blocks from VisualContent (content_type='text') as
 * semantic HTML. Consecutive 'bullet' blocks are grouped into a single <ul>,
 * with nested <ul> for depth > 0. Accessible navigation for screen readers.
 */
export default function TextBlocks({ blocks }: { blocks: TextBlock[] }) {
  if (!blocks || blocks.length === 0) return null;

  const rendered: React.ReactNode[] = [];
  let bulletBuffer: TextBlock[] = [];

  const flushBullets = (key: string) => {
    if (bulletBuffer.length === 0) return;
    rendered.push(renderBulletList(bulletBuffer, key));
    bulletBuffer = [];
  };

  blocks.forEach((b, i) => {
    if (b.kind === "bullet") {
      bulletBuffer.push(b);
      return;
    }
    flushBullets(`ul-${i}`);
    if (b.kind === "heading") {
      rendered.push(
        <h3
          key={`h-${i}`}
          className="text-base font-semibold mt-2 mb-1"
          style={{ color: "var(--foreground)" }}
        >
          <RichText text={b.text} />
        </h3>
      );
    } else {
      // paragraph
      rendered.push(
        <p
          key={`p-${i}`}
          className="text-sm leading-relaxed my-1"
          style={{ color: "var(--foreground)" }}
        >
          <RichText text={b.text} />
        </p>
      );
    }
  });
  flushBullets(`ul-end`);

  return <div>{rendered}</div>;
}

function renderBulletList(bullets: TextBlock[], key: string): React.ReactNode {
  // Group a flat list of bullets (possibly mixed depths) into a nested <ul>
  // structure. A depth-0 bullet owns any subsequent contiguous bullets of
  // depth > 0 as its children.
  const items: React.ReactNode[] = [];
  let i = 0;
  while (i < bullets.length) {
    const b = bullets[i];
    if (b.depth === 0) {
      const children: TextBlock[] = [];
      let j = i + 1;
      while (j < bullets.length && bullets[j].depth > 0) {
        children.push(bullets[j]);
        j++;
      }
      items.push(
        <li key={`li-${i}`} className="text-sm leading-relaxed">
          <RichText text={b.text} />
          {children.length > 0
            ? renderBulletList(
                children.map((c) => ({ ...c, depth: c.depth - 1 })),
                `ul-${i}-nest`
              )
            : null}
        </li>
      );
      i = j;
    } else {
      // Stray deep bullet with no parent — render at current level
      items.push(
        <li key={`li-${i}`} className="text-sm leading-relaxed">
          <RichText text={b.text} />
        </li>
      );
      i++;
    }
  }
  return (
    <ul
      key={key}
      className="list-disc pl-5 my-1"
      style={{ color: "var(--foreground)" }}
    >
      {items}
    </ul>
  );
}
