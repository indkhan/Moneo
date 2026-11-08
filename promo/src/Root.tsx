import { Composition } from "remotion";
import { Promo } from "./Promo";
import { BEAT, FPS, TOTAL_BEATS } from "./timeline";

export const Root = () => <Composition id="MoneoPromo" component={Promo} durationInFrames={Math.round(TOTAL_BEATS * BEAT * FPS)} fps={FPS} width={1920} height={1080} />;
