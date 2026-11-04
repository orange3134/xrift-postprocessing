// Rendering defaults are shared with the development-only controls. No UI here.
export const FINISH_DEFAULTS = {
  shaftStrength:.32, shaftRadius:.06, shaftLength:1,
  shaftBlur:.1, shaftSmoothing:.3,
  fogStart:40, fogDensity:.005,
  bloomThreshold:.71, bloomStrength:.6, bloomRadius:4, bloomKnee:.91,
  aberration:5, aberrationFalloff:1,
  exposure:.88, saturation:1.04, contrast:1.02, temperature:.03, tint:0,
  turquoise:.09, shadowLift:1.4, gradeMix:1, gamma:.9,
  vignetteStrength:.14, vignetteRadius:.62, vignetteSoftness:.42,
  grainStrength:.018, grainSize:1.2, grainSpeed:18,
}
export type FinishSettings=typeof FINISH_DEFAULTS
