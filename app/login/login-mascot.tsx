"use client";

import { useEffect, useRef, useState } from "react";
import { attachMascotTracking } from "./mascot-tracking";
import { enableMascotGyroscope, type MascotGyroscopeStatus } from "./mascot-gyroscope";
import "./login-mascot.css";

export default function LoginMascot() {
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const gyroscopeCleanup = useRef<(() => void) | null>(null);
  const [motionStatus, setMotionStatus] = useState<MascotGyroscopeStatus | "idle" | "requesting">("idle");

  useEffect(() => {
    mounted.current = true;
    if (!root.current) return;
    const cleanupTracking = attachMascotTracking(root.current);
    return () => {
      mounted.current = false;
      cleanupTracking();
      gyroscopeCleanup.current?.();
      gyroscopeCleanup.current = null;
    };
  }, []);

  const toggleGyroscope = async () => {
    if (gyroscopeCleanup.current) {
      gyroscopeCleanup.current();
      gyroscopeCleanup.current = null;
      setMotionStatus("idle");
      return;
    }
    if (!root.current) return;

    setMotionStatus("requesting");
    const session = await enableMascotGyroscope(root.current);
    if (!mounted.current) {
      session.cleanup();
      return;
    }
    if (session.status === "enabled") gyroscopeCleanup.current = session.cleanup;
    setMotionStatus(session.status);
  };

  const motionLabel: Record<MascotGyroscopeStatus | "idle" | "requesting", string> = {
    idle: "Aktifkan gerak",
    requesting: "Meminta izin sensor…",
    enabled: "Matikan gerak",
    denied: "Izin sensor ditolak · coba lagi",
    unsupported: "Sensor gerak tidak tersedia",
    "reduced-motion": "Gerak nonaktif · Reduce Motion",
  };

  return (
    <>
      <div className="login-mascot" data-login-mascot aria-hidden="true" ref={root}>
        <svg viewBox="0 0 240 200" fill="none" focusable="false">
          <ellipse cx="120" cy="181" rx="61" ry="9" fill="#092f2c" opacity="0.25" />
          <g className="login-mascot-head">
            <path d="M120 38V25" stroke="#b9f3d5" strokeWidth="5" strokeLinecap="round" />
            <circle cx="120" cy="19" r="7" fill="var(--mint)" stroke="var(--line)" strokeWidth="3" />
            <rect x="46" y="67" width="18" height="47" rx="8" fill="var(--mint)" stroke="var(--line)" strokeWidth="3" />
            <rect x="176" y="67" width="18" height="47" rx="8" fill="var(--mint)" stroke="var(--line)" strokeWidth="3" />
            <rect x="59" y="41" width="128" height="126" rx="37" fill="#092f2c" />
            <rect x="54" y="36" width="128" height="126" rx="37" fill="var(--lime)" stroke="var(--line)" strokeWidth="3" />
            <path d="M72 60c8-10 18-13 32-13" stroke="#f5ffe1" strokeWidth="4" strokeLinecap="round" />
            <rect x="69" y="69" width="98" height="57" rx="25" fill="var(--foreground)" />
            <g className="login-mascot-blink">
              <ellipse cx="96" cy="97" rx="14" ry="17" fill="#fff" />
              <ellipse cx="140" cy="97" rx="14" ry="17" fill="#fff" />
              <g className="login-mascot-pupils">
                <ellipse cx="96" cy="98" rx="5" ry="7" fill="var(--foreground)" />
                <ellipse cx="140" cy="98" rx="5" ry="7" fill="var(--foreground)" />
              </g>
            </g>
            <path d="M105 140q13 9 26 0" stroke="var(--foreground)" strokeWidth="4" strokeLinecap="round" />
            <circle cx="76" cy="137" r="5" fill="var(--mint)" />
            <circle cx="160" cy="137" r="5" fill="var(--mint)" />
          </g>
        </svg>
      </div>
      <div className="login-mascot-motion-control">
        <button
          aria-pressed={motionStatus === "enabled"}
          className="login-mascot-motion-button"
          data-mascot-gyro-toggle
          disabled={motionStatus === "requesting"}
          onClick={() => void toggleGyroscope()}
          type="button"
        >
          <span aria-live="polite">{motionLabel[motionStatus]}</span>
        </button>
      </div>
    </>
  );
}
