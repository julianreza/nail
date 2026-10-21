import { describe, expect, it, vi } from "vitest";
import { enableMascotGyroscope } from "../../app/login/mascot-gyroscope";

function harness(options: {
  permission?: "granted" | "denied";
  supported?: boolean;
  secure?: boolean;
  reduced?: boolean;
} = {}) {
  const values = new Map<string, string>();
  const attributes = new Map<string, string>();
  const pupilValues = new Map<string, string>();
  const antennaValues = new Map<string, string>();
  const furValues = new Map<string, string>();
  const frames = new Map<number, FrameRequestCallback>();
  const media = Object.assign(new EventTarget(), { matches: options.reduced ?? false });
  const requestPermission = vi.fn(async () => options.permission ?? "granted");
  const sensorConstructor = Object.assign(class DeviceOrientationEvent {}, { requestPermission });
  let sequence = 0;
  const view = Object.assign(new EventTarget(), {
    DeviceOrientationEvent: options.supported === false ? undefined : sensorConstructor,
    isSecureContext: options.secure ?? true,
    matchMedia: () => media,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const doc = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  const element = {
    ownerDocument: doc,
    style: { setProperty: (key: string, value: string) => values.set(key, value) },
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    querySelector: (selector: string) => {
      if (selector === ".login-mascot-pupils") return { style: { setProperty: (key: string, value: string) => pupilValues.set(key, value) } };
      if (selector === ".mascot-antenna") return { style: { setProperty: (key: string, value: string) => antennaValues.set(key, value) } };
      if (selector === "[data-mascot-fur-displacement]") return { setAttribute: (key: string, value: string) => furValues.set(key, value) };
      return null;
    },
  } as unknown as HTMLElement;
  const tilt = (beta: number | null, gamma: number | null) => {
    view.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma }));
  };
  const flush = () => {
    const batch = [...frames.values()];
    frames.clear();
    batch.forEach((callback) => callback(0));
  };
  return { element, values, attributes, pupilValues, antennaValues, furValues, frames, view, doc, media, requestPermission, tilt, flush };
}

describe("mobile mascot gyroscope", () => {
  it("requests permission and applies the latest coalesced tilt", async () => {
    const h = harness();
    const result = await enableMascotGyroscope(h.element);

    expect(result.status).toBe("enabled");
    expect(h.requestPermission).toHaveBeenCalledOnce();
    h.tilt(0, 0);
    h.tilt(15, -15);
    expect(h.attributes.get("data-mascot-idle")).toBe("false");
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.values.get("--mascot-eye-x")).toBe("-3px");
    expect(h.values.get("--mascot-eye-y")).toBe("2px");
    expect(h.values.get("--mascot-rotate")).toBe("-2deg");
    expect(h.pupilValues.get("--mascot-eye-x")).toBe("-3px");
    expect(h.pupilValues.get("--mascot-eye-y")).toBe("2px");
    expect(h.antennaValues.get("--mascot-antenna-rotate")).toBe("-4deg");
    expect(h.furValues.get("scale")).toBe("0.4");
    result.cleanup();
  });

  it("does not attach a sensor listener when permission is denied", async () => {
    const h = harness({ permission: "denied" });
    const result = await enableMascotGyroscope(h.element);

    expect(result.status).toBe("denied");
    h.tilt(15, 15);
    expect(h.frames.size).toBe(0);
  });

  it("falls back when the sensor is unavailable or the page is insecure", async () => {
    expect((await enableMascotGyroscope(harness({ supported: false }).element)).status).toBe("unsupported");
    const insecure = harness({ secure: false });
    expect((await enableMascotGyroscope(insecure.element)).status).toBe("unsupported");
    expect(insecure.requestPermission).not.toHaveBeenCalled();
  });

  it("keeps motion disabled when reduced motion is requested", async () => {
    const h = harness({ reduced: true });
    const result = await enableMascotGyroscope(h.element);

    expect(result.status).toBe("reduced-motion");
    expect(h.requestPermission).not.toHaveBeenCalled();
    h.tilt(20, 20);
    expect(h.frames.size).toBe(0);
  });

  it("resets on hidden tabs and cancels frames and listeners on cleanup", async () => {
    const h = harness();
    const result = await enableMascotGyroscope(h.element);
    h.tilt(15, 15);
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.values.get("--mascot-eye-x")).toBe("3px");
    h.doc.hidden = true;
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(h.values.get("--mascot-eye-x")).toBe("0px");
    h.doc.hidden = false;
    h.tilt(-15, -15);
    expect(h.frames.size).toBe(1);
    result.cleanup();
    expect(h.frames.size).toBe(0);
    h.tilt(-15, -15);
    expect(h.frames.size).toBe(0);
    expect(h.values.get("--mascot-eye-x")).toBe("0px");
  });
});
