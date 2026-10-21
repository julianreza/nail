export interface MascotPose {
  eyeX: number;
  eyeY: number;
  headX: number;
  headY: number;
  rotate: number;
}

export const NEUTRAL_POSE: MascotPose = {
  eyeX: 0,
  eyeY: 0,
  headX: 0,
  headY: 0,
  rotate: 0,
};

export function getMascotPose(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
): MascotPose {
  if (
    ![x, y, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return { ...NEUTRAL_POSE };
  }

  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const nx = clamp((x - bounds.left - bounds.width / 2) / (bounds.width / 2));
  const ny = clamp((y - bounds.top - bounds.height / 2) / (bounds.height / 2));

  return {
    eyeX: nx * 6,
    eyeY: ny * 4,
    headX: nx * 3,
    headY: ny * 2,
    rotate: nx * 4,
  };
}

export function getMascotPoseFromOrientation(beta: number | null, gamma: number | null): MascotPose {
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) {
    return { ...NEUTRAL_POSE };
  }

  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const nx = clamp(gamma / 30);
  const ny = clamp(beta / 30);

  return {
    eyeX: nx * 6,
    eyeY: ny * 4,
    headX: nx * 3,
    headY: ny * 2,
    rotate: nx * 4,
  };
}
