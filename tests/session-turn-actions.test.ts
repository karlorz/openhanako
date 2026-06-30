import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { replayLatestUserTurn } from "../core/session-turn-actions.ts";

function makeNavigableSession(manager) {
  return {
    sessionManager: manager,
    navigateTree: vi.fn(async (entryId) => {
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    }),
  };
}

describe("replayLatestUserTurn", () => {
  it("branches before the latest user message and replays the original prompt", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }] } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }] } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "try again" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      clientMessageId: "client-user",
      displayMessage: { text: "try again" },
    }, { submit });

    expect(session.navigateTree).not.toHaveBeenCalled();
    expect(manager.getBranch().map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "session_branch_reset",
      messageId: latestUserId,
      clientMessageId: "client-user",
    }, "/tmp/main.jsonl");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      sessionPath: "/tmp/main.jsonl",
      text: "try again",
      displayMessage: expect.objectContaining({ text: "try again" }),
    }));
  });

  it("replaces only the visible text when editing and preserves attachment markers", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new text",
      displayMessage: { text: "new text" },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "[attached_image: /tmp/a.png]\nnew text",
      images: undefined,
      imageAttachmentPaths: ["/tmp/a.png"],
      displayMessage: expect.objectContaining({ text: "new text" }),
    }));
  });

  it("branches before the latest user when editing a leaf user message", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const priorUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "context" }] } as any);
    const priorAssistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "context answer" }] } as any);
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "old leaf text" }] } as any);
    const session = makeNavigableSession(manager);
    session.navigateTree = vi.fn(async (entryId) => {
      if (entryId === manager.getLeafId?.()) return { cancelled: false };
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    });
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new leaf text",
      displayMessage: { text: "new leaf text" },
    }, { submit });

    expect(manager.getBranch().map(entry => entry.id)).toEqual([priorUserId, priorAssistantId]);
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "new leaf text",
      displayMessage: expect.objectContaining({ text: "new leaf text" }),
    }));
  });

  it("keeps persisted attached image markers as path-only replay inputs", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "old text" },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      images: undefined,
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("replays persisted marker-only image messages without synthesizing direct image payloads", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nread image" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "provider 400" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "read image" },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "[attached_image: /tmp/a.png]\nread image",
      images: undefined,
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("keeps existing inline image payloads on replay without rereading the path", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "[attached_image: /tmp/a.png]\nold text" },
        { type: "image", data: "BASE64_A", mimeType: "image/png" },
      ],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: { text: "old text" },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      images: [{ type: "image", data: "BASE64_A", mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
    }));
  });

  it("replays the requested image-backed user entry when the current leaf is off that branch", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nread all from image" }],
    } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] } as any);
    manager.resetLeaf();
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-filename"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      displayMessage: {
        text: "read all from image",
        attachments: [{ path: "/tmp/a.png", name: "a.png", isDir: false, mimeType: "image/png" }],
      },
    }, { submit, readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "[attached_image: /tmp/a.png]\nread all from image",
      images: undefined,
      imageAttachmentPaths: ["/tmp/a.png"],
      displayMessage: expect.objectContaining({
        text: "read all from image",
        attachments: [{ path: "/tmp/a.png", name: "a.png", isDir: false, mimeType: "image/png" }],
      }),
    }));
  });

  it("replays from display image attachments when no persisted source entry is available", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-display-attachment"));
    const sessionFile = {
      fileId: "sf_image",
      filePath: "/tmp/a.png",
      displayName: "a.png",
      mime: "image/png",
      kind: "image",
      isDirectory: false,
    };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      getSessionFile: vi.fn((fileId, options) => {
        expect(fileId).toBe("sf_image");
        expect(options).toEqual({ sessionPath: "/tmp/main.jsonl" });
        return sessionFile;
      }),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      clientMessageId: "client-user-image",
      displayMessage: {
        text: "read all from image",
        attachments: [{ fileId: "sf_image", path: "/tmp/a.png", name: "a.png", isDir: false, mimeType: "image/png" }],
      },
    }, { submit, readFile });

    expect(engine.emitEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "session_branch_reset",
    }), expect.anything());
    expect(readFile).toHaveBeenCalledWith("/tmp/a.png");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "read all from image",
      images: [{ type: "image", data: Buffer.from("png-by-display-attachment").toString("base64"), mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/a.png"],
      displayMessage: expect.objectContaining({
        text: "read all from image",
        attachments: [expect.objectContaining({
          fileId: "sf_image",
          path: "/tmp/a.png",
          name: "a.png",
          isDir: false,
          mimeType: "image/png",
        })],
      }),
    }));
  });

  it("replays an optimistic client image message instead of an older persisted user turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "older persisted prompt" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "older answer" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const readFile = vi.fn(async () => Buffer.from("png-by-optimistic-attachment"));
    const sessionFile = {
      fileId: "sf_optimistic_image",
      filePath: "/tmp/optimistic.png",
      displayName: "optimistic.png",
      mime: "image/png",
      kind: "image",
      isDirectory: false,
    };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      getSessionFile: vi.fn(() => sessionFile),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      clientMessageId: "client-user-optimistic-image",
      displayMessage: {
        text: "@optimistic.png read all from image",
        attachments: [{
          fileId: "sf_optimistic_image",
          path: "/tmp/optimistic.png",
          name: "optimistic.png",
          isDir: false,
          mimeType: "image/png",
        }],
      },
    }, { submit, readFile });

    expect(engine.emitEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "session_branch_reset",
    }), expect.anything());
    expect(readFile).toHaveBeenCalledWith("/tmp/optimistic.png");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "@optimistic.png read all from image",
      images: [{ type: "image", data: Buffer.from("png-by-optimistic-attachment").toString("base64"), mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/optimistic.png"],
    }));
    expect(submit).not.toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "older persisted prompt",
    }));
  });

  it("rejects spoofed display attachment paths when no persisted source entry is available", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const session = makeNavigableSession(manager);
    const submit = vi.fn();
    const readFile = vi.fn(async () => Buffer.from("not-an-image"));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      getSessionFileByPath: vi.fn(() => null),
    };

    await expect(replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      displayMessage: {
        text: "read all from image",
        attachments: [{ path: "/etc/passwd", name: "x.png", isDir: false, mimeType: "image/png" }],
      },
    }, { submit, readFile })).rejects.toThrow("No latest user message to replay");

    expect(engine.getSessionFileByPath).toHaveBeenCalledWith("/etc/passwd", { sessionPath: "/tmp/main.jsonl" });
    expect(readFile).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("clears stale agent context before replaying from display attachments", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const session: any = makeNavigableSession(manager);
    session.agent = {
      state: {
        messages: [{ role: "user", content: [{ type: "text", text: "stale" }] }],
      },
    };
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      displayMessage: {
        text: "read all from image",
        attachments: [{ path: "image-0", name: "image-0.png", isDir: false, base64Data: "BASE64_A", mimeType: "image/png" }],
      },
    }, { submit });

    expect(session.agent.state.messages).toEqual([]);
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "read all from image",
      images: [{ type: "image", data: "BASE64_A", mimeType: "image/png" }],
      imageAttachmentPaths: undefined,
      displayMessage: expect.objectContaining({
        attachments: [{ path: "image-0", name: "image-0.png", isDir: false, base64Data: "BASE64_A", mimeType: "image/png" }],
      }),
    }));
  });

  it("rejects a stale source entry instead of replaying the wrong turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const staleUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }] } as any);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "latest" }] } as any);
    const session = makeNavigableSession(manager);
    const submit = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await expect(replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: staleUserId,
    }, { submit })).rejects.toThrow("latest user message");

    expect(submit).not.toHaveBeenCalled();
  });
});
