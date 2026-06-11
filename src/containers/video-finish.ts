// Cloudflare Container DO wrapper for the video-finish service.
//
// The container itself (containers/video-finish/) is a CPU-only Python + ffmpeg
// HTTP service: POST /finish { clips, audioUrl?, outputUrl, ... } assembles the
// per-shot clips (normalize -> hard/xfade concat -> audio mux -> faststart) and
// PUTs the final MP4. The Worker reaches it via
// env.VIDEO_FINISH.get(idFromName("singleton")).fetch(...). Pattern matches the
// sibling AudioBeatSync / ImagePrep containers (see reference-cf-containers-work-now).
//
// This is the off-GPU tail of the render pipeline: ffmpeg concat/encode is pure
// CPU and used to run on GPU-billed pod seconds. Unlike the librosa/rembg
// containers there is no JIT/model cache to bake -- ffmpeg is a static binary,
// so the bind is immediate and the only warm is a build-time libx264 encode.

import { Container } from "@cloudflare/containers";
import type { Env } from "../env";

export class VideoFinishContainer extends Container<Env> {
  defaultPort = 8000;            // app.py binds 0.0.0.0:8000
  sleepAfter = "10m";            // idle eviction; render-finish usage is bursty
  enableInternet = true;         // fetches the presigned R2 GET/PUT URLs over the public endpoint
  instanceGetTimeoutMS = 60_000; // cold-start budget (image pull + bind)
  portReadyTimeoutMS = 30_000;   // bind time before the port is ready (no JIT, so fast)

  override onError(error: unknown) {
    console.log("VideoFinishContainer error:", error);
  }
}
