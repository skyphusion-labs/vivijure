// Cloudflare Container DO wrapper for the audio beat-sync service.
//
// The container itself (containers/audio-beat-sync/) is a CPU-only Python +
// librosa HTTP service: POST /analyze { audioUrl, ... } -> beat plan. The
// Worker reaches it via getContainer(env.AUDIO_BEAT_SYNC, ...).fetch(...).
// Pattern follows cloudflare/templates/containers-template (verified to
// activate on this account); see memory reference-cf-containers-work-now.
//
// CPU-only beat detection in a container, not the GPU pod: spinning a RunPod
// worker just to read an MP3 was wasteful (the pod analyze_audio action was
// reverted in vivijure-serverless 0.4.60). See docs/containers.md.

import { Container } from "@cloudflare/containers";
import type { Env } from "../env";

export class AudioBeatSyncContainer extends Container<Env> {
  defaultPort = 8000;            // app.py binds 0.0.0.0:8000
  sleepAfter = "10m";            // idle eviction; planner usage is sparse
  enableInternet = true;         // fetches the presigned R2 GET URL over the public endpoint
  instanceGetTimeoutMS = 60_000; // cold-start budget (image pull + librosa import)
  portReadyTimeoutMS = 30_000;   // bind + import time before the port is ready

  override onError(error: unknown) {
    console.log("AudioBeatSyncContainer error:", error);
  }
}
