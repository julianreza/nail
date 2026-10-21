import { getMascotPose, NEUTRAL_POSE, type MascotPose } from "./mascot-pose";

export function attachMascotTracking(element: HTMLElement): () => void {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => undefined;

  const fine = view.matchMedia("(hover: hover) and (pointer: fine)");
  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)");
  let frame: number | undefined;
  let point: { x: number; y: number } | undefined;

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
  const enabled = () => fine.matches && !reduced.matches && !doc.hidden;
  const reset = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    point = undefined;
    apply(NEUTRAL_POSE);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || !enabled()) return;
    point = { x: event.clientX, y: event.clientY };
    if (frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (!point || !enabled()) return;
      apply(getMascotPose(point.x, point.y, element.getBoundingClientRect()));
    });
  };

  view.addEventListener("pointermove", onPointerMove, { passive: true });
  view.addEventListener("blur", reset);
  view.addEventListener("resize", reset);
  view.addEventListener("scroll", reset, { passive: true, capture: true });
  doc.documentElement.addEventListener("pointerleave", reset);
  doc.addEventListener("visibilitychange", reset);
  fine.addEventListener("change", reset);
  reduced.addEventListener("change", reset);
  apply(NEUTRAL_POSE);

  return () => {
    view.removeEventListener("pointermove", onPointerMove);
    view.removeEventListener("blur", reset);
    view.removeEventListener("resize", reset);
    view.removeEventListener("scroll", reset, true);
    doc.documentElement.removeEventListener("pointerleave", reset);
    doc.removeEventListener("visibilitychange", reset);
    fine.removeEventListener("change", reset);
    reduced.removeEventListener("change", reset);
    reset();
  };
}
