/** Image lifecycle bridge calls. Higher-level orchestration (artboard mgmt,
 * preview restart, load tokens) lives in `store/editor-image.ts`; this module
 * is the raw bridge surface. */
export {
  exportImage,
  openImage,
  openImageFile,
  openPeerImage,
  pickDirectory,
  pickExportTarget,
  prepareImageOpen,
  restoreCurrentBrowserSnapshot,
} from "../bridge/index";
export { pairPeerDevice } from "../bridge/index";
