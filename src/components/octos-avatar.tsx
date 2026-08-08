import { useId } from "react";

import type { SvgTeacherSkin } from "@/hooks/use-teacher-skin";

import "./octos-avatar.css";

export function OctosAvatar({
  skin,
  className = "",
}: {
  skin: SvgTeacherSkin;
  className?: string;
}) {
  const gradientId = `octos-avatar-${useId().replaceAll(":", "")}`;

  return (
    <svg
      className={`octos-avatar-art ${className}`}
      data-skin={skin}
      viewBox="0 0 96 96"
      role="img"
      aria-label={`${skin} Octos skin`}
    >
      <defs>
        <linearGradient id={gradientId} x1="22" y1="14" x2="76" y2="84">
          <stop className="octos-avatar-gradient-start" />
          <stop offset="1" className="octos-avatar-gradient-end" />
        </linearGradient>
      </defs>

      <g className="octos-avatar-shadow" opacity="0.18">
        <ellipse cx="48" cy="82" rx="31" ry="6" />
      </g>

      <g className="octos-avatar-tentacles" fill={`url(#${gradientId})`}>
        <path d="M20 63c-8 4-9 15-2 18 6 3 11-1 12-7 1-3 4-4 7-2l1-10c-7-4-12-3-18 1Z" />
        <path d="M35 66c-5 7-3 17 4 18 6 1 9-5 8-11l-1-9-11 2Z" />
        <path d="M50 65v10c0 7 4 11 9 9 6-2 7-11 2-18l-11-1Z" />
        <path d="M60 63c8-3 14-1 17 5 4 8-2 15-8 12-4-2-4-7-8-8-2-1-4 0-6 2l5-11Z" />
      </g>

      <path
        className="octos-avatar-head"
        fill={`url(#${gradientId})`}
        d="M18 49c0-21 12-35 30-35s30 14 30 35c0 17-12 27-30 27S18 66 18 49Z"
      />
      <path
        className="octos-avatar-shine"
        d="M27 40c2-10 9-17 18-19"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="4"
      />

      {skin === "starlight" && (
        <g className="octos-avatar-stars">
          <path d="m29 35 1.5 3 3 .5-2.2 2.2.5 3.1-2.8-1.5-2.8 1.5.5-3.1-2.2-2.2 3-.5Z" />
          <circle cx="66" cy="33" r="2" />
          <circle cx="70" cy="53" r="1.3" />
        </g>
      )}

      <g className="octos-avatar-face">
        <ellipse cx="38" cy="49" rx="7" ry="8" fill="white" />
        <ellipse cx="59" cy="49" rx="7" ry="8" fill="white" />
        <circle cx="40" cy="51" r="3" fill="#21383f" />
        <circle cx="57" cy="51" r="3" fill="#21383f" />
        <path d="M43 62c3 3 7 3 10 0" fill="none" stroke="#21383f" strokeLinecap="round" strokeWidth="2.5" />
      </g>

      {skin === "scholar" && (
        <g className="octos-avatar-scholar">
          <g fill="none" stroke="currentColor" strokeWidth="2.3">
            <circle cx="38" cy="49" r="9" />
            <circle cx="59" cy="49" r="9" />
            <path d="M47 48h3" />
          </g>
          <path d="m24 24 25-12 25 12-25 11-25-11Z" />
          <path d="M67 26v12" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="67" cy="39" r="2.5" />
        </g>
      )}

      {skin === "coral" && (
        <g className="octos-avatar-coral-flower">
          <circle cx="68" cy="25" r="4" />
          <circle cx="62" cy="23" r="4" />
          <circle cx="65" cy="18" r="4" />
          <circle cx="71" cy="20" r="4" />
          <circle cx="66.5" cy="21.5" r="2.5" />
        </g>
      )}
    </svg>
  );
}
