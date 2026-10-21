import { describe, expect, it } from "vitest";
import { getMascotPose, getMascotPoseFromOrientation, NEUTRAL_POSE } from "../../app/login/mascot-pose";

const bounds = { left: 100, top: 50, width: 200, height: 100 };

describe("mascot pose", () => {
  it("looks forward at the center", () => {
    expect(getMascotPose(200, 100, bounds)).toEqual(NEUTRAL_POSE);
  });
  it("clamps movement even far outside the artwork", () => {
    expect(getMascotPose(10000, 10000, bounds)).toEqual({ eyeX: 6, eyeY: 4, headX: 3, headY: 2, rotate: 4 });
    expect(getMascotPose(-10000, -10000, bounds)).toEqual({ eyeX: -6, eyeY: -4, headX: -3, headY: -2, rotate: -4 });
  });
  it("produces proportional movement inside the bounds", () => {
    expect(getMascotPose(250, 125, bounds)).toEqual({ eyeX: 3, eyeY: 2, headX: 1.5, headY: 1, rotate: 2 });
  });
  it("maps phone tilt proportionally to bounded gaze", () => {
    expect(getMascotPoseFromOrientation(0, 0)).toEqual(NEUTRAL_POSE);
    expect(getMascotPoseFromOrientation(15, -15)).toEqual({
      eyeX: -3,
      eyeY: 2,
      headX: -1.5,
      headY: 1,
      rotate: -2,
    });
  });
  it("clamps extreme tilt and rejects invalid sensor readings", () => {
    expect(getMascotPoseFromOrientation(90, -90)).toEqual({
      eyeX: -6,
      eyeY: 4,
      headX: -3,
      headY: 2,
      rotate: -4,
    });
    expect(getMascotPoseFromOrientation(null, 10)).toEqual(NEUTRAL_POSE);
    expect(getMascotPoseFromOrientation(10, NaN)).toEqual(NEUTRAL_POSE);
  });
  it("fails safely for invalid coordinates or empty bounds", () => {
    expect(getMascotPose(NaN, 100, bounds)).toEqual(NEUTRAL_POSE);
    expect(getMascotPose(200, Infinity, bounds)).toEqual(NEUTRAL_POSE);
    expect(getMascotPose(200, 100, { ...bounds, width: 0 })).toEqual(NEUTRAL_POSE);
    expect(getMascotPose(200, 100, { ...bounds, left: NaN })).toEqual(NEUTRAL_POSE);
  });
});
