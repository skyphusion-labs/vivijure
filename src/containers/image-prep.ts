// Cloudflare Container DO wrapper for the image-prep service.
//
// The container (containers/image-prep/) is a CPU-only rembg background-removal
// HTTP service: POST /portrait/prep { inputUrl, outputUrl, ... }. The Worker
// reaches it via getContainer(env.IMAGE_PREP, ...).fetch(...). Same official
// template wiring as the audio container (Container<Env>, new_sqlite_classes);
// see memory reference-cf-containers-work-now.
//
// Moves the pod-side rembg (multi_character_regional.py:_slot_portraits) off
// the GPU image. See docs/containers.md.

import { Container } from "@cloudflare/containers";
import type { Env } from "../env";

export class ImagePrepContainer extends Container<Env> {
  defaultPort = 8000;            // app.py binds 0.0.0.0:8000
  sleepAfter = "10m";            // idle eviction; bundle traffic is bursty
  enableInternet = true;         // fetches/PUTs the presigned R2 URLs over the public endpoint
  instanceGetTimeoutMS = 60_000; // cold-start budget (image pull + ORT init)
  portReadyTimeoutMS = 30_000;

  override onError(error: unknown) {
    console.log("ImagePrepContainer error:", error);
  }
}
