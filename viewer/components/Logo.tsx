"use client";

import { useEffect, useState } from "react";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
}

export default function Logo({ size = "md", showText = true }: LogoProps) {
  const iconSize = { sm: 28, md: 36, lg: 48 }[size];
  const fontSize = { sm: "text-base", md: "text-xl", lg: "text-3xl" }[size];
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const check = () => setDark(document.documentElement.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Dark theme → light logo, Light theme → dark logo
  const logoSrc = dark ? "/logo-light.svg" : "/logo-dark.svg";

  return (
    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
      <img
        src={logoSrc}
        alt="Chalkboard"
        width={iconSize}
        height={iconSize}
        style={{ borderRadius: iconSize * 0.19 }}
      />
      {showText && (
        <span className={`${fontSize} font-semibold tracking-tight`} style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: "var(--foreground)" }}>chalkboard</span>
          <span style={{ color: "var(--muted-fg)" }}>{" "}ai</span>
        </span>
      )}
    </div>
  );
}
