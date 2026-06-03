/**
 * OpenAI-compatible input_audio helper.
 *
 * Pi SDK currently serializes non-text local media into image_url data URLs.
 * Audio-capable OpenAI-compatible providers such as MiMo expect input_audio
 * parts with raw base64 data plus a format string.
 */
import { audioFormatFromMimeType } from "../../shared/audio-mime.js";

export function normalizeOpenAIInputAudioPayload(payload) {
  if (!Array.isArray(payload?.messages)) return payload;

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let contentChanged = false;
    const content = message.content.map((part) => {
      const audio = getDataAudio(part);
      if (!audio) return part;

      const { image_url, imageUrl, data, mimeType, mime, ...rest } = part;
      contentChanged = true;
      return {
        ...rest,
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
        },
      };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? { ...payload, messages } : payload;
}

function getDataAudio(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "audio") return parseCanonicalAudioBlock(part);
  if (part.type !== "image_url") return null;
  const url = part.image_url?.url ?? part.imageUrl?.url;
  if (typeof url !== "string") return null;
  return parseAudioDataUrl(url);
}

function parseCanonicalAudioBlock(part) {
  const mimeType = part.mimeType || part.mime || "audio/wav";
  const format = audioFormatFromMimeType(mimeType);
  if (!format || typeof part.data !== "string") return null;
  return {
    data: part.data,
    format,
  };
}

function parseAudioDataUrl(url) {
  if (!url.toLowerCase().startsWith("data:audio/")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const metadata = url.slice(5, comma).toLowerCase();
  if (!metadata.includes(";base64")) return null;
  const mimeType = metadata.split(";")[0];
  const format = audioFormatFromMimeType(mimeType);
  if (!format) return null;
  return {
    data: url.slice(comma + 1),
    format,
  };
}
