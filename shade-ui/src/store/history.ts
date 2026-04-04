import * as Y from "yjs";
import { createSignal } from "solid-js";

const doc = new Y.Doc();
const snapshot = doc.getMap("snapshot");
const undoManager = new Y.UndoManager(snapshot, { captureTimeout: 500 });

const [canUndo, setCanUndo] = createSignal(false);
const [canRedo, setCanRedo] = createSignal(false);

function syncSignals() {
  setCanUndo(undoManager.undoStack.length > 0);
  setCanRedo(undoManager.redoStack.length > 0);
}

undoManager.on("stack-item-added", syncSignals);
undoManager.on("stack-item-popped", syncSignals);
undoManager.on("stack-item-updated", syncSignals);

let restoreHandler: ((data: string) => void) | null = null;
let recording = false;

export function onRestore(handler: (data: string) => void) {
  restoreHandler = handler;
}

snapshot.observe(() => {
  if (recording) return;
  const data = snapshot.get("layers");
  if (typeof data !== "string" || !restoreHandler) return;
  restoreHandler(data);
});

export function recordSnapshot(data: string) {
  recording = true;
  try {
    doc.transact(() => {
      snapshot.set("layers", data);
    });
  } finally {
    recording = false;
  }
}

export function undo() {
  undoManager.undo();
}

export function redo() {
  undoManager.redo();
}

export function resetHistory() {
  undoManager.clear();
  doc.transact(() => {
    snapshot.delete("layers");
  });
  syncSignals();
}

export { canUndo, canRedo };
