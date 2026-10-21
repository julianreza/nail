import { describe, expect, it, vi } from "vitest";
import { observeRoomMotion, type MotionEnvironment } from "../../app/agent-room-motion";

function setup() {
  let intersection: (visible: boolean) => void = () => {};
  const reduced = new EventTarget() as EventTarget & { matches: boolean };
  reduced.matches = false;
  const document = new EventTarget() as EventTarget & { hidden: boolean };
  document.hidden = false;
  const disconnect = vi.fn();
  const environment: MotionEnvironment = {
    document,
    media: reduced,
    observe: (_element, callback) => { intersection = callback; return disconnect; },
  };
  const notify = vi.fn();
  const cleanup = observeRoomMotion({} as Element, notify, environment);
  return { reduced, document, disconnect, notify, cleanup, intersect: (visible: boolean) => intersection(visible) };
}

describe("agent room motion permission", () => {
  it("starts paused and runs only while visible, foreground, and not reduced", () => {
    const s = setup();
    expect(s.notify).toHaveBeenLastCalledWith({ available: false, reduced: false });
    s.intersect(true);
    expect(s.notify).toHaveBeenLastCalledWith({ available: true, reduced: false });
    s.document.hidden = true;
    s.document.dispatchEvent(new Event("visibilitychange"));
    expect(s.notify).toHaveBeenLastCalledWith({ available: false, reduced: false });
    s.document.hidden = false;
    s.document.dispatchEvent(new Event("visibilitychange"));
    expect(s.notify).toHaveBeenLastCalledWith({ available: true, reduced: false });
    s.reduced.matches = true;
    s.reduced.dispatchEvent(new Event("change"));
    expect(s.notify).toHaveBeenLastCalledWith({ available: false, reduced: true });
    s.reduced.matches = false;
    s.reduced.dispatchEvent(new Event("change"));
    expect(s.notify).toHaveBeenLastCalledWith({ available: true, reduced: false });
    s.intersect(false);
    expect(s.notify).toHaveBeenLastCalledWith({ available: false, reduced: false });
    s.cleanup();
  });

  it("disconnects and removes listeners on cleanup", () => {
    const s = setup();
    s.cleanup();
    const calls = s.notify.mock.calls.length;
    s.document.dispatchEvent(new Event("visibilitychange"));
    s.reduced.dispatchEvent(new Event("change"));
    expect(s.disconnect).toHaveBeenCalledOnce();
    expect(s.notify).toHaveBeenCalledTimes(calls);
  });
});
