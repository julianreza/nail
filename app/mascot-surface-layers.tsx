import { useId } from "react";

export default function MascotSurfaceLayers() {
  const prefix = `mascot-surface-${useId().replaceAll(":", "")}`;
  const antennaMask = `${prefix}-antenna-mask`;
  const bodyMask = `${prefix}-body-mask`;
  const faceMask = `${prefix}-face-mask`;
  const furMask = `${prefix}-fur-mask`;
  const furFilter = `${prefix}-fur-filter`;
  const antennaShape = <path d="M111 35C108 29 108 23 111 18C114 12 119 9 124 12C130 16 131 23 128 29C126 34 123 38 122 43L128 53L123 61L116 53L118 43Z" />;
  const faceShape = <ellipse cx="120" cy="116" rx="47" ry="48" />;
  const source = <image href="/branding/nail-monster-body.png" x="0" y="-20" width="240" height="240" preserveAspectRatio="none" />;

  return (
    <g className="mascot-surfaces">
      <defs>
        <mask id={antennaMask} maskUnits="userSpaceOnUse" x="0" y="-20" width="240" height="240" style={{ maskType: "luminance" }}>
          <g fill="white">{antennaShape}</g>
        </mask>
        <mask id={bodyMask} maskUnits="userSpaceOnUse" x="0" y="-20" width="240" height="240" style={{ maskType: "luminance" }}>
          <rect x="0" y="-20" width="240" height="240" fill="white" />
          <g fill="black">{antennaShape}{faceShape}</g>
        </mask>
        <mask id={faceMask} maskUnits="userSpaceOnUse" x="0" y="-20" width="240" height="240" style={{ maskType: "luminance" }}>
          <g fill="white">{faceShape}</g>
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
      <g mask={`url(#${bodyMask})`}>
        <g mask={`url(#${furMask})`}>
          <g className="mascot-fur" data-mascot-surface="fur" filter={`url(#${furFilter})`}>
            {source}
          </g>
        </g>
        <g mask={`url(#${faceMask})`} data-mascot-surface="face">
          {source}
        </g>
      </g>
      <g className="mascot-antenna" data-mascot-surface="antenna" mask={`url(#${antennaMask})`}>
        {source}
      </g>
    </g>
  );
}
