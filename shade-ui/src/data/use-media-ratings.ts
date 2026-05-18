import * as bridge from "../bridge/index";
import type { MediaRatingParams } from "../bridge/types";

export function listMediaRatings(ids: string[]): Promise<Record<string, number>> {
  return bridge.listMediaRatings(ids);
}

export function setMediaRating(params: MediaRatingParams): Promise<void> {
  return bridge.setMediaRating(params);
}
