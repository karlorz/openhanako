import { submitDesktopSessionMessage } from "./desktop-session-submit.ts";
import fsp from "fs/promises";
import path from "path";
import { detectMime, extOfName, inferFileKind } from "../lib/file-metadata.ts";

const ATTACHMENT_MARKER_RE = /^\[(attached_(?:image|video):[^\]]+)\]\s*$/;
const ATTACHED_IMAGE_MARKER_RE = /\[attached_image:\s*([^\]]+)\]/g;

export async function replayLatestUserTurn(engine, opts: Record<string, any> = {}, deps: Record<string, any> = {}) {
  const submit = deps.submit || submitDesktopSessionMessage;
  const {
    sessionPath,
    sourceEntryId,
    clientMessageId,
    replacementText,
    displayMessage,
    uiContext,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function") {
    throw new Error("latest user replay requires engine.ensureSessionLoaded");
  }
  if (!sessionPath) throw new Error("sessionPath is required");
  if (typeof engine.isSessionStreaming === "function" && engine.isSessionStreaming(sessionPath)) {
    throw new Error("session_busy");
  }
  if (replacementText != null && !String(replacementText).trim()) {
    throw new Error("replacement text is required");
  }

  const session = await engine.ensureSessionLoaded(sessionPath);
  if (!session?.sessionManager) {
    throw new Error(`failed to load session ${sessionPath}`);
  }

  const latestOnBranch = findLatestUserEntry(session.sessionManager.getBranch());
  const requested = sourceEntryId
    ? findUserEntryById(session.sessionManager, sourceEntryId)
    : null;
  if (sourceEntryId && !requested) {
    throw new Error("Requested message is not the latest user message");
  }
  if (sourceEntryId && latestOnBranch && latestOnBranch.id !== sourceEntryId) {
    throw new Error("Requested message is not the latest user message");
  }
  // Confirmed local sends can keep a client-user-* UI id after persistence.
  // Prefer a valid persisted source entry; use display fallback only while the
  // optimistic message has no branch entry yet.
  const latest = requested || (isOptimisticClientUserMessageId(clientMessageId) ? null : latestOnBranch);
  if (!latest) {
    return await replayFromDisplayMessage(engine, sessionPath, displayMessage, replacementText, uiContext, deps, session);
  }

  const original = promptPayloadFromUserMessage(latest.message);
  const promptText = replacementText == null
    ? original.text
    : mergeAttachmentMarkers(original.text, String(replacementText));
  const imageAttachmentPaths = attachedImagePathsFromText(promptText);
  const images = original.images;

  branchBeforeUserEntry(session, latest);

  engine.emitEvent?.({
    type: "session_branch_reset",
    messageId: latest.id,
    clientMessageId: clientMessageId || null,
  }, sessionPath);

  return await submit(engine, {
    sessionPath,
    text: promptText,
    images: images.length ? images : undefined,
    imageAttachmentPaths: imageAttachmentPaths.length ? imageAttachmentPaths : undefined,
    displayMessage: {
      ...(displayMessage || {}),
      text: displayMessage?.text ?? (replacementText == null ? visibleUserText(original.text) : String(replacementText)),
    },
    uiContext,
  });
}

async function replayFromDisplayMessage(engine, sessionPath, displayMessage, replacementText, uiContext, deps, session) {
  const submit = deps.submit || submitDesktopSessionMessage;
  const fallback = await promptPayloadFromDisplayMessage(engine, sessionPath, displayMessage, replacementText, deps);
  if (!fallback) throw new Error("No latest user message to replay");
  replaceAgentMessagesFromBranch(session);
  return await submit(engine, {
    sessionPath,
    text: fallback.text,
    images: fallback.images.length ? fallback.images : undefined,
    imageAttachmentPaths: fallback.imageAttachmentPaths.length ? fallback.imageAttachmentPaths : undefined,
    displayMessage: {
      ...(displayMessage || {}),
      text: replacementText == null ? (displayMessage?.text ?? fallback.text) : String(replacementText),
      ...(fallback.displayAttachments.length ? { attachments: fallback.displayAttachments } : { attachments: undefined }),
    },
    uiContext,
  });
}

async function imagePayloadsFromPaths(paths, deps: Record<string, any> = {}) {
  const readFile = deps.readFile || fsp.readFile;
  const images = [];
  for (const filePath of paths) {
    const buffer = await readFile(filePath);
    const bytes = Buffer.from(buffer);
    images.push({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: detectMime(bytes, "image/png", filePath),
    });
  }
  return images;
}

async function promptPayloadFromDisplayMessage(engine, sessionPath, displayMessage, replacementText, deps: Record<string, any> = {}) {
  const text = replacementText == null
    ? String(displayMessage?.text || "")
    : String(replacementText);
  const { imageRefs, displayAttachments, hadImageAttachmentCandidate } = imageRefsFromDisplayAttachments(
    engine,
    sessionPath,
    displayMessage?.attachments,
  );
  const images = [];
  const pathsToRead = [];
  const imageAttachmentPaths = [];

  for (const ref of imageRefs) {
    if (ref.path) imageAttachmentPaths.push(ref.path);
    if (ref.base64Data) {
      images.push({
        type: "image",
        data: ref.base64Data,
        mimeType: ref.mimeType || "image/png",
      });
    } else if (ref.path) {
      pathsToRead.push(ref.path);
    }
  }

  images.push(...await imagePayloadsFromPaths(uniqueStrings(pathsToRead), deps));
  const uniqueImageAttachmentPaths = uniqueStrings(imageAttachmentPaths);
  if (hadImageAttachmentCandidate && images.length === 0) return null;
  if (!text && images.length === 0) return null;
  return { text, images, imageAttachmentPaths: uniqueImageAttachmentPaths, displayAttachments };
}

function imageRefsFromDisplayAttachments(engine, sessionPath, attachments) {
  if (!Array.isArray(attachments)) return { imageRefs: [], displayAttachments: [], hadImageAttachmentCandidate: false };
  const refs = [];
  const displayAttachments = [];
  let hadImageAttachmentCandidate = false;
  for (const attachment of attachments) {
    if (!attachment || attachment.isDir || attachment.isDirectory) continue;
    const trustedFile = trustedImageFileForAttachment(engine, sessionPath, attachment);
    const trustedPath = trustedFile ? readablePathFromSessionFile(trustedFile) : "";
    const inlineBase64 = typeof attachment.base64Data === "string" && attachment.base64Data
      ? attachment.base64Data
      : "";
    const isImageCandidate = isImageAttachmentCandidate(attachment) || !!trustedFile;
    if (!isImageCandidate) continue;
    hadImageAttachmentCandidate = true;
    if (!inlineBase64 && !trustedPath) continue;

    const mimeType = imageMimeTypeForAttachment(attachment, trustedFile);
    refs.push({
      path: trustedPath,
      base64Data: inlineBase64,
      mimeType,
    });
    displayAttachments.push(trustedFile
      ? displayAttachmentFromTrustedFile(attachment, trustedFile, trustedPath, mimeType)
      : displayAttachmentFromInlineImage(attachment, inlineBase64, mimeType));
  }
  return { imageRefs: refs, displayAttachments, hadImageAttachmentCandidate };
}

function trustedImageFileForAttachment(engine, sessionPath, attachment) {
  let file = null;
  const fileId = typeof attachment?.fileId === "string" && attachment.fileId.trim()
    ? attachment.fileId.trim()
    : "";
  if (fileId && typeof engine?.getSessionFile === "function") {
    file = engine.getSessionFile(fileId, { sessionPath });
  }
  const attachmentPath = typeof attachment?.path === "string" ? attachment.path.trim() : "";
  if (!file && attachmentPath && path.isAbsolute(attachmentPath) && typeof engine?.getSessionFileByPath === "function") {
    file = engine.getSessionFileByPath(attachmentPath, { sessionPath });
  }
  if (!isTrustedImageFile(file)) return null;
  if (!readablePathFromSessionFile(file)) return null;
  return file;
}

function isTrustedImageFile(file) {
  if (!file || file.isDir || file.isDirectory) return false;
  if (file.kind) return file.kind === "image";
  return inferFileKind({
    mime: file.mime || file.mimeType || file.contentType,
    ext: file.ext || extOfName(file.filename || file.displayName || file.label || file.filePath || file.realPath),
    isDirectory: !!file.isDir || !!file.isDirectory,
  }) === "image";
}

function readablePathFromSessionFile(file) {
  const candidates = [file?.filePath, file?.realPath];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() && path.isAbsolute(candidate.trim())) {
      return candidate.trim();
    }
  }
  return "";
}

function isImageAttachmentCandidate(attachment) {
  if (!attachment || attachment.isDir || attachment.isDirectory) return false;
  if (typeof attachment.base64Data === "string" && attachment.base64Data) return true;
  const attachmentPath = typeof attachment.path === "string" ? attachment.path.trim() : "";
  const name = attachment.name || attachment.label || attachmentPath;
  return inferFileKind({
    mime: attachment.mimeType,
    ext: extOfName(name),
    isDirectory: !!attachment.isDir || !!attachment.isDirectory,
  }) === "image";
}

function imageMimeTypeForAttachment(attachment, file) {
  return file?.mime || file?.mimeType || attachment?.mimeType || "image/png";
}

function displayAttachmentFromTrustedFile(attachment, file, filePath, mimeType) {
  return {
    ...attachment,
    fileId: file.fileId || file.id || attachment.fileId,
    path: filePath,
    name: attachment.name || file.displayName || file.filename || file.label || path.basename(filePath),
    isDir: false,
    mimeType,
    ...(file.presentation ? { presentation: file.presentation } : {}),
    ...(file.listed !== undefined ? { listed: file.listed !== false } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(Object.prototype.hasOwnProperty.call(file, "missingAt") ? { missingAt: file.missingAt } : {}),
    ...(file.waveform ? { waveform: file.waveform } : {}),
  };
}

function displayAttachmentFromInlineImage(attachment, base64Data, mimeType) {
  const attachmentPath = typeof attachment?.path === "string" ? attachment.path.trim() : "";
  const name = attachment?.name || attachment?.label || "image";
  return {
    path: attachmentPath && !path.isAbsolute(attachmentPath) ? attachmentPath : name,
    name,
    isDir: false,
    base64Data,
    mimeType,
  };
}

function findLatestUserEntry(branch) {
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "user") return entry;
  }
  return null;
}

function findUserEntryById(sessionManager, entryId) {
  const entry = sessionManager?.getEntry?.(entryId);
  if (entry?.type === "message" && entry.message?.role === "user") return entry;
  return null;
}

function isOptimisticClientUserMessageId(clientMessageId) {
  return typeof clientMessageId === "string" && clientMessageId.startsWith("client-user-");
}

function promptPayloadFromUserMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };

  const text = content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("");
  const images = content
    .filter(block => block?.type === "image")
    .map(block => ({ ...block }));
  return { text, images };
}

function attachedImagePathsFromText(text) {
  const paths = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(ATTACHED_IMAGE_MARKER_RE)) {
    const filePath = String(match[1] || "").trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function mergeAttachmentMarkers(originalText, replacementText) {
  const markers = [];
  for (const line of String(originalText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!ATTACHMENT_MARKER_RE.test(trimmed)) break;
    markers.push(trimmed);
  }
  return markers.length ? `${markers.join("\n")}\n${replacementText}` : replacementText;
}

function visibleUserText(text) {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length && ATTACHMENT_MARKER_RE.test(lines[0].trim())) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function branchBeforeUserEntry(session, entry) {
  if (entry.parentId) {
    session.sessionManager.branch(entry.parentId);
  } else {
    session.sessionManager.resetLeaf();
  }
  replaceAgentMessagesFromBranch(session);
}

function replaceAgentMessagesFromBranch(session) {
  const context = session.sessionManager.buildSessionContext();
  if (session.agent?.replaceMessages) {
    session.agent.replaceMessages(context.messages);
  } else if (session.agent?.state) {
    session.agent.state.messages = context.messages;
  }
}
