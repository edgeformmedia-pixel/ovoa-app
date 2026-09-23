import { WithSkiaWeb } from "@shopify/react-native-skia/lib/module/web";
import { View } from "react-native";
import type { OrbMode } from "./Orb";

// The browser preview (`expo start --web`) has no Skia until CanvasKit loads.
// It comes from the CDN at the version Skia was built against, rather than a
// 7 MB file kept in the repo for a preview nobody ships.
const CANVASKIT = "0.41.0";

export type { OrbMode };
export function OrbView(props: { mode: OrbMode; level: number; size?: number }) {
  const size = props.size ?? 220;
  return (
    <WithSkiaWeb
      opts={{ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/canvaskit-wasm@${CANVASKIT}/bin/full/${file}` }}
      getComponent={() => import("./Orb")}
      fallback={<View style={{ width: size, height: size }} />}
      componentProps={props}
    />
  );
}
