import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionContext,
  ActionsRegistry,
  buildActionContext,
} from "../src/store/actions";
import { setState } from "../src/store/editor-store";
import {
  setMediaViewFocusedItemId,
  setMediaViewSelectedItemIds,
  setMediaViewSelectedLibraryId,
} from "../src/store/media-view-context";

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    currentView: "media",
    mediaViewFocusedItemId: null,
    mediaViewSelectedItemIds: [],
    selectedLibraryId: null,
    hasImage: false,
    selectedLayerIdx: -1,
    selectedLayerPart: "layer",
    isCropMode: false,
    ...overrides,
  };
}

function keyboardEvent(init: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("ActionsRegistry", () => {
  let registry: ActionsRegistry;

  beforeEach(() => {
    registry = new ActionsRegistry();
  });

  describe("register / unregister / get", () => {
    it("stores and retrieves an action", () => {
      const def = { id: "test.foo", title: "Foo", run: () => {} };
      registry.register(def);
      expect(registry.get("test.foo")?.title).toBe("Foo");
    });

    it("returns undefined for unknown ids", () => {
      expect(registry.get("unknown")).toBeUndefined();
    });

    it("removes action and its shortcuts on unregister", () => {
      registry.register({ id: "test.a", title: "A", run: () => {} });
      registry.mapShortcut("mod+a", "test.a");
      registry.unregister("test.a");
      expect(registry.get("test.a")).toBeUndefined();
      expect(
        registry.handleKey(keyboardEvent({ key: "a", metaKey: true }), makeCtx()),
      ).toBe(false);
    });
  });

  describe("entries", () => {
    it("returns all registered actions", () => {
      registry.register({ id: "a", title: "A", run: () => {} });
      registry.register({ id: "b", title: "B", run: () => {} });
      const ids = Array.from(registry.entries()).map(([id]) => id);
      expect(ids).toEqual(["a", "b"]);
    });
  });

  describe("available", () => {
    it("returns all actions without when predicate", () => {
      registry.register({ id: "a", title: "A", run: () => {} });
      expect(registry.available(makeCtx())).toHaveLength(1);
    });

    it("filters actions by when predicate", () => {
      registry.register({ id: "a", title: "A", when: () => false, run: () => {} });
      registry.register({
        id: "b",
        title: "B",
        when: (ctx) => ctx.hasImage,
        run: () => {},
      });
      registry.register({ id: "c", title: "C", run: () => {} });
      const available = registry.available(makeCtx({ hasImage: true }));
      expect(available.map((a) => a.id)).toEqual(["b", "c"]);
    });
  });

  describe("run", () => {
    it("executes sync action and records history", () => {
      const run = vi.fn();
      registry.register({ id: "test.action", title: "Action", run });
      const ctx = makeCtx();
      registry.run("test.action", ctx);
      expect(run).toHaveBeenCalledWith(ctx);
      expect(registry.getHistory()).toEqual(["test.action"]);
    });

    it("executes async action and records history", async () => {
      const run = vi.fn(async () => {});
      registry.register({ id: "test.async", title: "Async", run });
      registry.run("test.async", makeCtx());
      expect(run).toHaveBeenCalled();
      expect(registry.getHistory()).toEqual(["test.async"]);
    });

    it("throws when action is missing", () => {
      expect(() => registry.run("missing", makeCtx())).toThrow(
        "Action 'missing' not found",
      );
    });

    it("catches async rejection silently", async () => {
      const err = new Error("boom");
      registry.register({
        id: "test.fail",
        title: "Fail",
        run: async () => {
          throw err;
        },
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      registry.run("test.fail", makeCtx());
      await new Promise((r) => setTimeout(r, 10));
      expect(consoleSpy).toHaveBeenCalledWith("Action 'test.fail' failed:", err);
      consoleSpy.mockRestore();
    });
  });

  describe("shortcuts", () => {
    it("maps and resolves a simple key", () => {
      const run = vi.fn();
      registry.register({ id: "test.enter", title: "Enter", run });
      registry.mapShortcut("enter", "test.enter");
      const event = keyboardEvent({ key: "Enter" });
      expect(registry.handleKey(event, makeCtx())).toBe(true);
      expect(run).toHaveBeenCalled();
    });

    it("maps and resolves mod+key", () => {
      const run = vi.fn();
      registry.register({ id: "test.save", title: "Save", run });
      registry.mapShortcut("mod+s", "test.save");
      const event = keyboardEvent({ key: "s", metaKey: true });
      expect(registry.handleKey(event, makeCtx())).toBe(true);
      expect(run).toHaveBeenCalled();
    });

    it("maps and resolves shift+key", () => {
      const run = vi.fn();
      registry.register({ id: "test.shift", title: "Shift", run });
      registry.mapShortcut("shift+tab", "test.shift");
      const event = keyboardEvent({ key: "Tab", shiftKey: true });
      expect(registry.handleKey(event, makeCtx())).toBe(true);
      expect(run).toHaveBeenCalled();
    });

    it("returns false for unmapped shortcuts", () => {
      expect(registry.handleKey(keyboardEvent({ key: "x" }), makeCtx())).toBe(false);
    });

    it("returns false when when predicate rejects", () => {
      const run = vi.fn();
      registry.register({
        id: "test.conditional",
        title: "Conditional",
        when: (ctx) => ctx.hasImage,
        run,
      });
      registry.mapShortcut("mod+c", "test.conditional");
      const event = keyboardEvent({ key: "c", metaKey: true });
      expect(registry.handleKey(event, makeCtx({ hasImage: false }))).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it("unmaps a shortcut", () => {
      registry.register({ id: "test.x", title: "X", run: () => {} });
      registry.mapShortcut("x", "test.x");
      registry.unmapShortcut("x");
      expect(registry.handleKey(keyboardEvent({ key: "x" }), makeCtx())).toBe(false);
    });
  });

  describe("history", () => {
    it("tracks run order newest first", () => {
      registry.register({ id: "a", title: "A", run: () => {} });
      registry.register({ id: "b", title: "B", run: () => {} });
      registry.run("a", makeCtx());
      registry.run("b", makeCtx());
      expect(registry.getHistory()).toEqual(["b", "a"]);
    });
  });

  describe("rank", () => {
    it("returns 2 for title match", () => {
      registry.register({ id: "a", title: "Export PNG", run: () => {} });
      expect(registry.rank("a", "export")).toBe(2);
    });

    it("returns 1 for description match", () => {
      registry.register({
        id: "a",
        title: "Foo",
        description: "Export the image",
        run: () => {},
      });
      expect(registry.rank("a", "export")).toBe(1);
    });

    it("returns 0 for no match", () => {
      registry.register({ id: "a", title: "Foo", description: "Bar", run: () => {} });
      expect(registry.rank("a", "xyz")).toBe(0);
    });

    it("returns 0 for unknown action", () => {
      expect(registry.rank("missing", "foo")).toBe(0);
    });
  });
});

describe("buildActionContext integration", () => {
  beforeEach(() => {
    setMediaViewFocusedItemId(null);
    setMediaViewSelectedItemIds([]);
    setMediaViewSelectedLibraryId(null);
    setState({
      currentView: "media",
      canvasWidth: 0,
      isLoading: false,
      selectedLayerIdx: -1,
      selectedLayerPart: "layer",
      isCropMode: false,
    });
  });

  it("reads selectedLibraryId from mediaViewSelectedLibraryId signal", () => {
    setMediaViewSelectedLibraryId("lib-123");
    const ctx = buildActionContext();
    expect(ctx.selectedLibraryId).toBe("lib-123");
  });

  it("reads focused item from mediaViewFocusedItemId signal", () => {
    setMediaViewFocusedItemId("item-456");
    const ctx = buildActionContext();
    expect(ctx.mediaViewFocusedItemId).toBe("item-456");
  });

  it("reads selected items from mediaViewSelectedItemIds signal", () => {
    setMediaViewSelectedItemIds(["a", "b"]);
    const ctx = buildActionContext();
    expect(ctx.mediaViewSelectedItemIds).toEqual(["a", "b"]);
  });

  it("reads currentView from editor store", () => {
    setState("currentView", "editor");
    const ctx = buildActionContext();
    expect(ctx.currentView).toBe("editor");
  });

  it("computes hasImage from canvasWidth", () => {
    setState("canvasWidth", 1920);
    const ctx = buildActionContext();
    expect(ctx.hasImage).toBe(true);
  });

  it("computes hasImage from isLoading", () => {
    setState({ canvasWidth: 0, isLoading: true });
    const ctx = buildActionContext();
    expect(ctx.hasImage).toBe(true);
  });
});

describe("MediaView actions integration", () => {
  let registry: ActionsRegistry;
  let runLog: string[];

  beforeEach(() => {
    registry = new ActionsRegistry();
    runLog = [];

    setMediaViewFocusedItemId(null);
    setMediaViewSelectedItemIds([]);
    setMediaViewSelectedLibraryId(null);
    setState({
      currentView: "media",
      canvasWidth: 0,
      isLoading: false,
      selectedLayerIdx: -1,
      selectedLayerPart: "layer",
      isCropMode: false,
    });

    const mediaWhen = (ctx: { currentView: string; selectedLibraryId: string | null }) =>
      ctx.currentView === "media" && ctx.selectedLibraryId !== null;

    // Mirror what MediaView actually registers
    registry.register({
      id: "media.select-all",
      title: "Select All Images",
      group: "Media",
      when: mediaWhen,
      run: () => {
        runLog.push("select-all");
      },
    });

    registry.register({
      id: "media.toggle-selection",
      title: "Toggle Image Selection",
      group: "Media",
      when: (ctx) => ctx.currentView === "media" && ctx.mediaViewFocusedItemId !== null,
      run: () => {
        runLog.push("toggle-selection");
      },
    });

    registry.register({
      id: "media.navigate-up",
      title: "Navigate Up",
      group: "Media",
      when: mediaWhen,
      run: () => {
        runLog.push("navigate-up");
      },
    });

    registry.register({
      id: "media.prev-library",
      title: "Previous Library",
      group: "Media",
      when: mediaWhen,
      run: () => {
        runLog.push("prev-library");
      },
    });

    registry.register({
      id: "media.next-library",
      title: "Next Library",
      group: "Media",
      when: mediaWhen,
      run: () => {
        runLog.push("next-library");
      },
    });

    // Mirror actual shortcut strings from MediaView
    registry.mapShortcut("mod+a", "media.select-all");
    registry.mapShortcut(" ", "media.toggle-selection");
    registry.mapShortcut("arrowup", "media.navigate-up");
    registry.mapShortcut("[", "media.prev-library");
    registry.mapShortcut("]", "media.next-library");
  });

  it("mod+a runs select-all when a library is selected", () => {
    setMediaViewSelectedLibraryId("lib-1");
    const event = keyboardEvent({ key: "a", metaKey: true });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["select-all"]);
  });

  it("mod+a is blocked when no library is selected", () => {
    setMediaViewSelectedLibraryId(null);
    const event = keyboardEvent({ key: "a", metaKey: true });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });

  it("space runs toggle-selection when an item is focused", () => {
    setMediaViewSelectedLibraryId("lib-1");
    setMediaViewFocusedItemId("item-1");
    const event = keyboardEvent({ key: " " });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["toggle-selection"]);
  });

  it("space is blocked when no item is focused", () => {
    setMediaViewSelectedLibraryId("lib-1");
    setMediaViewFocusedItemId(null);
    const event = keyboardEvent({ key: " " });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });

  it("arrowup runs navigate-up when a library is selected", () => {
    setMediaViewSelectedLibraryId("lib-1");
    const event = keyboardEvent({ key: "ArrowUp" });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["navigate-up"]);
  });

  it("arrowup is blocked when no library is selected", () => {
    setMediaViewSelectedLibraryId(null);
    const event = keyboardEvent({ key: "ArrowUp" });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });

  it("[ runs prev-library when a library is selected", () => {
    setMediaViewSelectedLibraryId("lib-1");
    const event = keyboardEvent({ key: "[" });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["prev-library"]);
  });

  it("[ is blocked when no library is selected", () => {
    setMediaViewSelectedLibraryId(null);
    const event = keyboardEvent({ key: "[" });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });

  it("] runs next-library when a library is selected", () => {
    setMediaViewSelectedLibraryId("lib-1");
    const event = keyboardEvent({ key: "]" });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["next-library"]);
  });

  it("] is blocked when no library is selected", () => {
    setMediaViewSelectedLibraryId(null);
    const event = keyboardEvent({ key: "]" });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });

  it("unregistered shortcut does nothing", () => {
    setMediaViewSelectedLibraryId("lib-1");
    const event = keyboardEvent({ key: "x", metaKey: true });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });
});

describe("App actions integration", () => {
  let registry: ActionsRegistry;
  let runLog: string[];

  beforeEach(() => {
    registry = new ActionsRegistry();
    runLog = [];

    setState({
      canvasWidth: 1920,
      isLoading: false,
      selectedLayerIdx: 2,
      selectedLayerPart: "layer",
      isCropMode: false,
    });

    // Mirror what App.tsx actually registers
    registry.register({
      id: "editor.undo",
      title: "Undo",
      group: "Editor",
      when: (ctx) => ctx.hasImage,
      run: () => {
        runLog.push("undo");
      },
    });

    registry.register({
      id: "editor.redo",
      title: "Redo",
      group: "Editor",
      when: (ctx) => ctx.hasImage,
      run: () => {
        runLog.push("redo");
      },
    });

    registry.mapShortcut("mod+z", "editor.undo");
    registry.mapShortcut("mod+shift+z", "editor.redo");
  });

  it("mod+z runs undo when image is loaded", () => {
    const event = keyboardEvent({ key: "z", metaKey: true });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["undo"]);
  });

  it("mod+shift+z runs redo when image is loaded", () => {
    const event = keyboardEvent({ key: "z", metaKey: true, shiftKey: true });
    expect(registry.handleKey(event, buildActionContext())).toBe(true);
    expect(runLog).toEqual(["redo"]);
  });

  it("mod+z is blocked when no image is loaded", () => {
    setState("canvasWidth", 0);
    const event = keyboardEvent({ key: "z", metaKey: true });
    expect(registry.handleKey(event, buildActionContext())).toBe(false);
    expect(runLog).toEqual([]);
  });
});
