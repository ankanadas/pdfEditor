import { DesktopPlatform } from './desktop/input.js';
import { MobilePlatform } from './mobile/input.js';

/**
 * SINGLE source of truth for desktop-vs-mobile selection. Kept isolated so the policy is
 * swappable. Mirrors the app's existing CSS breakpoint (the @media (max-width:767px) block):
 * a narrow viewport OR a coarse (touch) primary pointer counts as mobile.
 */
export function detectPlatform() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'desktop';
  const narrow = window.matchMedia('(max-width: 767px)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  return (narrow || coarse) ? 'mobile' : 'desktop';
}

/** Build the one platform adapter for this session and inject it onto the app. */
export function buildPlatform(app) {
  return detectPlatform() === 'mobile' ? new MobilePlatform(app) : new DesktopPlatform(app);
}
