import type { Attachment, AttachmentInfo, AttachmentType } from './types.js';

export const attachmentLimits = Object.freeze({ files: 5, fileBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 });
export const attachmentTypes: readonly AttachmentType[] = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
export const imageTypes: readonly AttachmentType[] = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The first bytes of each type, so a file is what its media type says. */
const signatures: Record<AttachmentType, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/gif': (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')),
  'image/webp': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (bytes) => bytes.subarray(0, 5).toString('latin1') === '%PDF-',
};

const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
const maxName = 120;

export interface ReadAttachments {
  files: Attachment[];
  info: AttachmentInfo[];
}

/**
 * Checks the attachments of a run. A value of the wrong shape is a programming error and throws; a file that is too
 * large, of another type or with content that does not match its type is a problem with what the user sent, so it is
 * returned as an error message.
 */
export function readAttachments(value: unknown): ReadAttachments | { error: string } {
  if (value === undefined) return { files: [], info: [] };
  if (!Array.isArray(value)) throw new TypeError('attachments must be an array');
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.mediaType !== 'string' || typeof item.data !== 'string' ||
        (item.name !== undefined && typeof item.name !== 'string')) {
      throw new TypeError('Each attachment needs mediaType and data as strings, and name as a string when given');
    }
  }
  if (value.length > attachmentLimits.files) return { error: `At most ${attachmentLimits.files} files can be attached to a message.` };
  const files: Attachment[] = [];
  const info: AttachmentInfo[] = [];
  let total = 0;
  for (const [index, { name: givenName, mediaType, data }] of (value as Attachment[]).entries()) {
    const name = givenName === undefined ? undefined : cleanName(givenName);
    const label = name ? `File "${name}"` : `Attachment ${index + 1}`;
    if (!(attachmentTypes as string[]).includes(mediaType)) {
      return { error: `${label} is ${mediaType || 'of an unknown type'}; only PNG, JPEG, GIF and WebP images and PDF documents can be attached.` };
    }
    const prefix = `data:${mediaType};base64,`;
    let encoded = data.startsWith('data:') ? (data.startsWith(prefix) ? data.slice(prefix.length) : undefined) : data;
    if (encoded === undefined) return { error: `${label} is a data URL of another type than ${mediaType}.` };
    encoded = encoded.replace(/\s/g, '');
    // Checked on the encoded length first, so an oversized file is not decoded.
    if (encoded.length > Math.ceil(attachmentLimits.fileBytes / 3) * 4) return { error: `${label} is larger than ${mb(attachmentLimits.fileBytes)}.` };
    if (!encoded || encoded.length % 4 !== 0 || !base64Pattern.test(encoded)) return { error: `${label} is not valid base64 data.` };
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > attachmentLimits.fileBytes) return { error: `${label} is larger than ${mb(attachmentLimits.fileBytes)}.` };
    total += bytes.length;
    if (total > attachmentLimits.totalBytes) return { error: `The attached files are larger than ${mb(attachmentLimits.totalBytes)} together.` };
    if (!signatures[mediaType](bytes)) return { error: `${label} is not a ${mediaType} file.` };
    files.push({ ...(name ? { name } : {}), mediaType, data: encoded });
    info.push({ ...(name ? { name } : {}), mediaType, size: bytes.length });
  }
  return { files, info };
}

/** A file name the model can read as a name: one line, no brackets, at most 120 characters. */
function cleanName(name: string) {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > maxName ? `${clean.slice(0, maxName)}…` : clean;
}

function mb(bytes: number) {
  return `${bytes / 1024 / 1024} MB`;
}

/** A file as a data URL, the way OpenAI-style APIs take inline files. */
export function dataUrl({ mediaType, data }: Attachment) {
  return `data:${mediaType};base64,${data}`;
}

/** The name a provider shows for a file; PDF inputs need one. */
export function fileName({ name, mediaType }: Attachment, index: number) {
  return name || `attachment-${index + 1}.${mediaType.split('/')[1]}`;
}

/** The line the model reads in a message for its files. */
export function attachmentNote(info: AttachmentInfo[]) {
  const files = info.map(({ name, mediaType }) => name ? `${name} (${mediaType})` : mediaType);
  return `[Attached: ${files.join(', ')}]`;
}

/** Reads the attachment info of a message given as history. */
export function readAttachmentInfo(value: unknown): AttachmentInfo[] {
  if (!Array.isArray(value)) throw new TypeError('history attachments must be an array');
  return value.map((item) => {
    const { name, mediaType, size } = item ?? {};
    if (!(attachmentTypes as unknown[]).includes(mediaType) || !Number.isSafeInteger(size) || size < 0 ||
        (name !== undefined && typeof name !== 'string')) {
      throw new TypeError('A history attachment needs a supported mediaType, a size and, when given, a name');
    }
    return { ...(name ? { name: cleanName(name) } : {}), mediaType, size };
  });
}
