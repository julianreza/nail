import { useId } from "react";

export default function MascotSurfaceLayers() {
  const prefix = `mascot-surface-${useId().replaceAll(":", "")}`;
  const antennaMask = `${prefix}-antenna-mask`;
  const faceMask = `${prefix}-face-mask`;
  const furMask = `${prefix}-fur-mask`;
  const furFilter = `${prefix}-fur-filter`;
  // Traced against the 1024px export: the whole ball and stalk, down to its root.
  // Keep the adjacent head tufts outside this mask so they cannot be torn away.
  const antennaShape = <path d="M116.0156 -20L194.5312 -20L194.5312 43.2812L161.7188 43.2812L161.7188 37.4219L129.375 37.4219L129.375 42.1094L117.6562 42.1094L117.6562 37.4219L116.0156 37.4219Z" />;
  const faceShape = <ellipse cx="120" cy="116" rx="47" ry="48" />;
  const source = <image href="/branding/nail-monster-body.png" x="0" y="-20" width="240" height="240" preserveAspectRatio="none" />;

  return (
    <g className="mascot-surfaces">
      <defs>
        <mask id={antennaMask} maskUnits="userSpaceOnUse" x="0" y="-20" width="240" height="240" style={{ maskType: "luminance" }}>
          <g fill="white">{antennaShape}</g>
        </mask>
        <mask id={faceMask} maskUnits="userSpaceOnUse" x="0" y="-20" width="240" height="240" style={{ maskType: "luminance" }}>
          {/* Subpixel overlap prevents an antialiased transparent ring at the face/fur join. */}
          <ellipse cx="120" cy="116" rx="47.5" ry="48.5" fill="white" />
        </mask>
        <mask id={furMask} maskUnits="userSpaceOnUse" x="0" y="-20" width="240" height="240" style={{ maskType: "luminance" }}>
          <rect x="0" y="-20" width="240" height="240" fill="white" />
          <g fill="black">{antennaShape}{faceShape}</g>
        </mask>
        <filter id={furFilter} filterUnits="userSpaceOnUse" x="-10" y="-30" width="260" height="260" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="1" seed="7" result="fur-noise" />
          <feDisplacementMap data-mascot-fur-displacement in="SourceGraphic" in2="fur-noise" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g mask={`url(#${furMask})`}>
        <g className="mascot-fur" data-mascot-surface="fur" filter={`url(#${furFilter})`}>
          {source}
        </g>
      </g>
      {/* This must be a sibling: a parent excluding the face also erases this restoration. */}
      <g mask={`url(#${faceMask})`} data-mascot-surface="face">
        {source}
      </g>
      <g className="mascot-antenna" data-mascot-surface="antenna">
        <g mask={`url(#${antennaMask})`} data-antenna-pivot="123.5156 42.1094">
          {source}
        </g>
      </g>
    </g>
  );
}
