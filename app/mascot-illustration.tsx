import { useId } from "react";
import { MASCOT_EYE_CLIP } from "./mascot-eye-geometry";

export default function MascotIllustration() {
  const clipId = `nail-mascot-eye-${useId().replaceAll(":", "")}`;
  return (
    <svg viewBox="0 0 240 200" fill="none" focusable="false" data-monster-mascot>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <ellipse cx={MASCOT_EYE_CLIP.cx} cy={MASCOT_EYE_CLIP.cy} rx={MASCOT_EYE_CLIP.rx} ry={MASCOT_EYE_CLIP.ry} />
        </clipPath>
      </defs>
      <g className="login-mascot-head">
        <image href="/branding/nail-monster-body.png" x="0" y="-20" width="240" height="240" preserveAspectRatio="none" />
        <g clipPath={`url(#${clipId})`}>
          <g className="login-mascot-pupils">
            <image href="/branding/nail-monster-pupil.png" x="0" y="-20" width="240" height="240" preserveAspectRatio="none" />
          </g>
        </g>
      </g>
    </svg>
  );
}
