"use client";

import { useEffect, useRef, useState } from "react";
import { attachMascotTracking } from "./mascot-tracking";
import { enableMascotGyroscope, type MascotGyroscopeStatus } from "./mascot-gyroscope";
import MascotIllustration from "../mascot-illustration";
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
        <MascotIllustration />
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
