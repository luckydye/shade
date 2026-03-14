import { getThumbnail } from "./bridge/index";

export async function resolveMediaSrc(path: string): Promise<string> {
  return getThumbnail(path);
}
