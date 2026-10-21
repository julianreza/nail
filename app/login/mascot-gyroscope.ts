import { getMascotPoseFromOrientation, NEUTRAL_POSE, type MascotPose } from "./mascot-pose";

type PermissionResult = "granted" | "denied";
type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<PermissionResult>;
};

export type MascotGyroscopeStatus = "enabled" | "denied" | "unsupported" | "reduced-motion";

export interface MascotGyroscopeSession {
  status: MascotGyroscopeStatus;
  cleanup: () => void;
}

function inactive(status: Exclude<MascotGyroscopeStatus, "enabled">): MascotGyroscopeSession {
  return { status, cleanup: () => undefined };
}

export async function enableMascotGyroscope(element: HTMLElement): Promise<MascotGyroscopeSession> {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view || !view.isSecureContext) return inactive("unsupported");

  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) return inactive("reduced-motion");

  const sensorConstructor = (view as Window & { DeviceOrientationEvent?: OrientationEventConstructor })
    .DeviceOrientationEvent;
  if (!sensorConstructor) return inactive("unsupported");

  if (sensorConstructor.requestPermission) {
    try {
      if (await sensorConstructor.requestPermission() !== "granted") return inactive("denied");
    } catch {
      return inactive("denied");
    }
  }
  if (reduced.matches) return inactive("reduced-motion");

  let frame: number | undefined;
  let orientation: { beta: number | null; gamma: number | null } | undefined;
  const apply = (pose: MascotPose) => {
    const eyeX = `${pose.eyeX}px`;
    const eyeY = `${pose.eyeY}px`;
    element.style.setProperty("--mascot-eye-x", eyeX);
    element.style.setProperty("--mascot-eye-y", eyeY);
    element.style.setProperty("--mascot-head-x", `${pose.headX}px`);
    element.style.setProperty("--mascot-head-y", `${pose.headY}px`);
    element.style.setProperty("--mascot-rotate", `${pose.rotate}deg`);
    const pupils = element.querySelector<SVGElement>(".login-mascot-pupils");
    pupils?.style.setProperty("--mascot-eye-x", eyeX);
    pupils?.style.setProperty("--mascot-eye-y", eyeY);
  };
  const reset = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    orientation = undefined;
    apply(NEUTRAL_POSE);
  };
  const onOrientation = (event: Event) => {
    if (doc.hidden || reduced.matches) {
      reset();
      return;
    }
    const reading = event as DeviceOrientationEvent;
    orientation = { beta: reading.beta, gamma: reading.gamma };
    if (frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (!orientation || doc.hidden || reduced.matches) return;
      apply(getMascotPoseFromOrientation(orientation.beta, orientation.gamma));
    });
  };
  const onVisibilityChange = () => {
    if (doc.hidden) reset();
  };
  const onMotionPreferenceChange = () => {
    if (reduced.matches) reset();
  };

  view.addEventListener("deviceorientation", onOrientation, { passive: true });
  doc.addEventListener("visibilitychange", onVisibilityChange);
  reduced.addEventListener("change", onMotionPreferenceChange);
  apply(NEUTRAL_POSE);

  return {
    status: "enabled",
    cleanup: () => {
      view.removeEventListener("deviceorientation", onOrientation);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      reduced.removeEventListener("change", onMotionPreferenceChange);
      reset();
    },
  };
}
