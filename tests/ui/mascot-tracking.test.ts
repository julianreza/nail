import { afterEach, describe, expect, it, vi } from "vitest";
import { attachMascotTracking } from "../../app/login/mascot-tracking";

function harness() {
  const values = new Map<string, string>();
  const attributes = new Map<string, string>();
  const pupilValues = new Map<string, string>();
  const antennaValues = new Map<string, string>();
  const furValues = new Map<string, string>();
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const fine = Object.assign(new EventTarget(), { matches: true });
  const reduced = Object.assign(new EventTarget(), { matches: false });
  const view = Object.assign(new EventTarget(), {
    matchMedia: (query: string) => query.includes("reduced-motion") ? reduced : fine,
    requestAnimationFrame: (cb: FrameRequestCallback) => { frames.set(++sequence, cb); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const doc = Object.assign(new EventTarget(), { defaultView: view, hidden: false, documentElement: new EventTarget() });
  const element = {
    ownerDocument: doc,
    style: { setProperty: (key: string, value: string) => { values.set(key, value); } },
    setAttribute: (key: string, value: string) => { attributes.set(key, value); },
    querySelector: (selector: string) => {
      if (selector === ".login-mascot-pupils") return { style: { setProperty: (key: string, value: string) => { pupilValues.set(key, value); } } };
      if (selector === ".mascot-antenna") return { style: { setProperty: (key: string, value: string) => { antennaValues.set(key, value); } } };
      if (selector === "[data-mascot-fur-displacement]") return { setAttribute: (key: string, value: string) => { furValues.set(key, value); } };
      return null;
    },
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
  } as unknown as HTMLElement;
  const move = (x: number, y: number, pointerType = "mouse") => {
    view.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y, pointerType }));
  };
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((cb) => cb(0)); };
  return { element, values, attributes, pupilValues, antennaValues, furValues, frames, view, doc, fine, reduced, move, flush };
}

afterEach(() => vi.restoreAllMocks());

describe("mascot tracking", () => {
  it("coalesces events and applies the latest bounded gaze", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.move(100, 50); h.move(10000, 10000);
    expect(h.attributes.get("data-mascot-idle")).toBe("false");
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.values.get("--mascot-eye-x")).toBe("6px");
    expect(h.values.get("--mascot-eye-y")).toBe("4px");
    expect(h.values.get("--mascot-rotate")).toBe("4deg");
    expect(h.pupilValues.get("--mascot-eye-x")).toBe("6px");
    expect(h.pupilValues.get("--mascot-eye-y")).toBe("4px");
    expect(h.antennaValues.get("--mascot-antenna-rotate")).toBe("5deg");
    expect(h.furValues.get("scale")).toBe("0.8");
    cleanup();
  });
  it("ignores touch, disables reduced motion, and resets on blur", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.move(10000, 10000, "touch"); expect(h.frames.size).toBe(0);
    h.move(10000, 10000); h.flush();
    h.view.dispatchEvent(new Event("blur"));
    expect(h.values.get("--mascot-eye-x")).toBe("0px");
    h.reduced.matches = true; h.reduced.dispatchEvent(new Event("change"));
    h.move(10000, 10000); expect(h.frames.size).toBe(0);
    cleanup();
  });
  it("ignores mouse tracking when the primary pointer is coarse", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.fine.matches = false; h.fine.dispatchEvent(new Event("change"));
    h.move(10000, 10000);
    expect(h.frames.size).toBe(0);
    expect(h.values.get("--mascot-eye-x")).toBe("0px");
    cleanup();
  });
  it("resets on exit/hide and drops pending work and listeners on cleanup", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.move(10000, 10000); h.flush();
    h.doc.documentElement.dispatchEvent(new Event("pointerleave"));
    expect(h.values.get("--mascot-rotate")).toBe("0deg");
    h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange"));
    h.move(10000, 10000); expect(h.frames.size).toBe(0);
    h.doc.hidden = false; h.move(10000, 10000);
    expect(h.frames.size).toBe(1);
    cleanup(); expect(h.frames.size).toBe(0);
    h.move(0, 0); expect(h.frames.size).toBe(0);
  });
});
