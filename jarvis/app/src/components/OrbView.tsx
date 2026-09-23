import Orb, { type OrbMode } from "./Orb";

// The orb, where Skia is already in the app (iOS). The web build loads Skia's
// engine first (OrbView.web.tsx), which only the browser preview needs.
export type { OrbMode };
export function OrbView(props: { mode: OrbMode; level: number; size?: number }) {
  return <Orb {...props} />;
}
