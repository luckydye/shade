import { type Accessor, createSignal } from "solid-js";
import { setMediaRating } from "../../bridge/index";
import { type ArtboardState, setState } from "../../store/editor-store";

function mediaRatingId(artboard: ArtboardState | null): string | null {
  if (!artboard) return null;
  switch (artboard.source.kind) {
    case "path":
      return artboard.activeFingerprint ?? artboard.source.path;
    case "peer":
      return `peer:${artboard.source.peerEndpointId}:${artboard.source.picture.id}`;
    case "file":
      return artboard.activeFingerprint;
    default:
      throw new Error("unknown artboard source");
  }
}

export function useArtboardRating(selectedArtboard: Accessor<ArtboardState | null>): {
  ratingId: Accessor<string | null>;
  rating: Accessor<number | null>;
  saving: Accessor<boolean>;
  setRating: (rating: number | null) => Promise<void>;
} {
  const [saving, setSaving] = createSignal(false);

  const ratingId = () => mediaRatingId(selectedArtboard());
  const rating = () => selectedArtboard()?.activeMediaRating ?? null;

  const setRating = async (next: number | null) => {
    const artboard = selectedArtboard();
    const id = mediaRatingId(artboard);
    if (!artboard || !id || saving()) return;

    const resolvedNext = next ?? artboard.activeMediaBaseRating;
    const previous = artboard.activeMediaRating;
    setState(
      "artboards",
      (candidate) => candidate.id === artboard.id,
      "activeMediaRating",
      resolvedNext,
    );
    setSaving(true);
    try {
      await setMediaRating({ fingerprint: id, rating: next });
    } catch (error) {
      setState(
        "artboards",
        (candidate) => candidate.id === artboard.id,
        "activeMediaRating",
        previous,
      );
      setState("loadError", error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return { ratingId, rating, saving, setRating };
}
