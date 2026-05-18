import * as bridge from "../bridge/index";
import type { MediaRatingParams } from "../bridge/types";

export function useMediaRatings(): {
  listMediaRatings: (ids: string[]) => Promise<Record<string, number>>;
  setMediaRating: (params: MediaRatingParams) => Promise<void>;
} {
  return {
    listMediaRatings,
    setMediaRating,
  };
}

function listMediaRatings(ids: string[]): Promise<Record<string, number>> {
  return bridge.listMediaRatings(ids);
}

function setMediaRating(params: MediaRatingParams): Promise<void> {
  return bridge.setMediaRating(params);
}
