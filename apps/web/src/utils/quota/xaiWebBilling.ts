/**
 * Binary-safe grok.com billing fallback over the management api-call proxy.
 *
 * `GetGrokCreditsConfig` is a gRPC-web endpoint. With the `grpc-web-text`
 * content type both the request frame and the response are base64 ASCII, so
 * the response survives the api-call JSON transport that would UTF-8-mangle
 * raw binary protobuf. The OAuth token never leaves the proxy: the request
 * carries `Authorization: Bearer $TOKEN$` and the proxy substitutes it
 * server-side against a fixed origin.
 *
 * Wire semantics follow the grok.com web client billing descriptor as
 * documented by CodexBar's GrokWebBillingFetcher: proto3
 * `credit_usage_percent` is an implicit-presence float, so an omitted scalar
 * reads as 0% used only for a complete single-frame response with a
 * recognized active weekly/monthly current period and no fixed32 field
 * anywhere. Every other shape yields no percent — never an invented value.
 * Parser failures surface as fixed reason codes; response bytes are never
 * copied into errors or logs.
 */

const MAX_WEB_BILLING_TEXT_LENGTH = 65_536;
const MAX_PROTO_SCAN_DEPTH = 4;
const MIN_TIMESTAMP_SECONDS = 1_700_000_000;
const MAX_TIMESTAMP_SECONDS = 2_100_000_000;
/** GetGrokCreditsConfigRequest { exclude_legacy_monthly_usage: false }. */
const CURRENT_PERIOD_TYPE_PATH = '1,8,1';
const CURRENT_PERIOD_START_PATH = '1,8,2,1';
const CURRENT_PERIOD_END_PATH = '1,8,3,1';
const BILLING_PERIOD_END_PATH = '1,5,1';

/** Billing descriptor messages that are safe to recurse into; other
 * length-delimited fields stay opaque bytes and can neither invalidate the
 * response nor contribute percent/reset values. */
const KNOWN_BILLING_MESSAGE_PATHS: ReadonlySet<string> = new Set([
  '1',
  '1,2',
  '1,3',
  '1,4',
  '1,5',
  '1,6',
  '1,7',
  '1,8',
  '1,12',
  '1,6,1',
  '1,6,2',
  '1,6,3',
  '1,8,2',
  '1,8,3',
  '1,6,3,2',
  '1,6,3,3',
]);

export type XaiWebBillingPercentSource = 'grpc-wire' | 'grpc-implicit-zero';

export type XaiWebBillingPeriodType = 'weekly' | 'monthly' | 'unknown';

export type XaiWebBillingNoPercentReason =
  | 'rpc-error'
  | 'no-trailer'
  | 'incomplete'
  | 'multi-frame'
  | 'fixed32-present'
  | 'unknown-period-type'
  | 'inactive-period';

export type XaiWebBillingInvalidReason = 'empty' | 'bad-base64' | 'bad-frame';

export type XaiWebBillingParseResult =
  | {
      outcome: 'percent';
      usedPercent: number;
      source: XaiWebBillingPercentSource;
      periodType: XaiWebBillingPeriodType;
      periodStartMs: number | null;
      periodEndMs: number | null;
      resetAtMs: number | null;
    }
  | { outcome: 'no-percent'; reason: XaiWebBillingNoPercentReason; grpcStatus?: number }
  | { outcome: 'invalid'; reason: XaiWebBillingInvalidReason };

const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let index = 0; index < 64; index += 1) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  BASE64_LOOKUP[alphabet.charCodeAt(index)] = index;
}

const decodeBase64Chunk = (chunk: string): Uint8Array | null => {
  let dataLength = chunk.length;
  while (dataLength > 0 && chunk[dataLength - 1] === '=') dataLength -= 1;
  if (dataLength % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((dataLength * 3) / 4));
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < dataLength; index += 1) {
    const code = BASE64_LOOKUP[chunk.charCodeAt(index) & 0x7f];
    if (code < 0) return null;
    buffer = (buffer << 6) | code;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
};

/** Decodes grpc-web-text: base64 chunks that may each carry their own padding
 * (grok.com pads the data and trailer frames separately). Returns null on any
 * structural violation. */
export const decodeGrpcWebText = (body: unknown): Uint8Array | null => {
  if (typeof body !== 'string') return null;
  let text = '';
  for (const char of body) {
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') continue;
    text += char;
    if (text.length > MAX_WEB_BILLING_TEXT_LENGTH) return null;
  }
  if (text.length === 0) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;

  const chunks: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '=') {
      let padding = 0;
      while (index < text.length && text[index] === '=') {
        padding += 1;
        index += 1;
      }
      if (padding > 2 || current.length === 0) return null;
      chunks.push(current + '='.repeat(padding));
      current = '';
      index -= 1;
      continue;
    }
    current += char;
  }
  if (current.length > 0) chunks.push(current);

  const parts: Uint8Array[] = [];
  let totalLength = 0;
  for (const chunk of chunks) {
    const decoded = decodeBase64Chunk(chunk);
    if (decoded === null) return null;
    parts.push(decoded);
    totalLength += decoded.length;
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

interface GrpcWebFrames {
  dataFrames: Uint8Array[];
  trailerFields: Record<string, string>;
}

const parseGrpcWebFrames = (bytes: Uint8Array): GrpcWebFrames | null => {
  const dataFrames: Uint8Array[] = [];
  const trailerFields: Record<string, string> = {};
  let sawTrailer = false;
  let index = 0;
  while (index < bytes.length) {
    if (index + 5 > bytes.length) return null;
    const flags = bytes[index];
    const length =
      ((bytes[index + 1] << 24) |
        (bytes[index + 2] << 16) |
        (bytes[index + 3] << 8) |
        bytes[index + 4]) >>>
      0;
    const start = index + 5;
    const end = start + length;
    if (end > bytes.length) return null;
    const payload = bytes.subarray(start, end);
    if ((flags & 0x80) !== 0) {
      sawTrailer = true;
      const text = decodeUtf8(payload);
      if (text === null) return null;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(':');
        if (separator <= 0) continue;
        trailerFields[trimmed.slice(0, separator).trim().toLowerCase()] = trimmed
          .slice(separator + 1)
          .trim();
      }
    } else {
      dataFrames.push(payload);
    }
    index = end;
  }
  if (!sawTrailer && dataFrames.length === 0) return null;
  return { dataFrames, trailerFields };
};

interface ProtobufField {
  path: number[];
  value: number;
}

interface ProtobufScan {
  fixed32Fields: Array<ProtobufField & { order: number }>;
  varintFields: ProtobufField[];
  complete: boolean;
}

const readVarint = (
  bytes: Uint8Array,
  index: { value: number }
): { value: number; complete: boolean } => {
  let result = 0;
  let shift = 0;
  while (index.value < bytes.length && shift < 64) {
    const byte = bytes[index.value];
    index.value += 1;
    if (shift === 63 && byte > 1) return { value: 0, complete: false };
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return { value: result, complete: true };
    shift += 7;
  }
  return { value: 0, complete: false };
};

const scanProtobuf = (
  bytes: Uint8Array,
  path: number[],
  depth: number,
  scan: ProtobufScan
): void => {
  const index = { value: 0 };
  while (index.value < bytes.length) {
    const fieldStart = index.value;
    const key = readVarint(bytes, index);
    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 0x07;
    if (!key.complete || fieldNumber <= 0 || fieldNumber > 536_870_911) {
      scan.complete = false;
      index.value = fieldStart + 1;
      continue;
    }
    const fieldPath = [...path, fieldNumber];
    if (wireType === 0) {
      const value = readVarint(bytes, index);
      if (!value.complete) {
        scan.complete = false;
        index.value = fieldStart + 1;
        continue;
      }
      scan.varintFields.push({ path: fieldPath, value: value.value });
    } else if (wireType === 1) {
      if (index.value + 8 > bytes.length) {
        scan.complete = false;
        return;
      }
      index.value += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, index);
      if (!length.complete || length.value > bytes.length - index.value) {
        scan.complete = false;
        index.value = fieldStart + 1;
        continue;
      }
      const start = index.value;
      index.value = start + length.value;
      if (depth < MAX_PROTO_SCAN_DEPTH && KNOWN_BILLING_MESSAGE_PATHS.has(fieldPath.join(','))) {
        scanProtobuf(bytes.subarray(start, index.value), fieldPath, depth + 1, scan);
      }
    } else if (wireType === 5) {
      if (index.value + 4 > bytes.length) {
        scan.complete = false;
        return;
      }
      const bitPattern =
        bytes[index.value] |
        (bytes[index.value + 1] << 8) |
        (bytes[index.value + 2] << 16) |
        (bytes[index.value + 3] << 24) |
        0;
      scan.fixed32Fields.push({
        path: fieldPath,
        value: new Float32Array(new Int32Array([bitPattern]).buffer)[0],
        order: scan.fixed32Fields.length,
      });
      index.value += 4;
    } else {
      scan.complete = false;
      index.value = fieldStart + 1;
    }
  }
};

const pathKey = (path: number[]): string => path.join(',');

const findVarintField = (scan: ProtobufScan, path: string): ProtobufField | undefined =>
  scan.varintFields.find((field) => pathKey(field.path) === path);

const isTimestampSeconds = (value: number): boolean =>
  value >= MIN_TIMESTAMP_SECONDS && value <= MAX_TIMESTAMP_SECONDS;

const resolvePeriodType = (typeValue: number | null): XaiWebBillingPeriodType => {
  if (typeValue === 2) return 'weekly';
  if (typeValue === 1) return 'monthly';
  return 'unknown';
};

const isRecognizedPeriodType = (scan: ProtobufScan): boolean => {
  const typeField = findVarintField(scan, CURRENT_PERIOD_TYPE_PATH);
  return typeField !== undefined && (typeField.value === 1 || typeField.value === 2);
};

/** The recognized current period type (1=monthly, 2=weekly) must carry start
 * and end bounds containing the current time. */
const hasActiveCurrentPeriod = (scan: ProtobufScan, nowMs: number): boolean => {
  if (!isRecognizedPeriodType(scan)) return false;
  const start = findVarintField(scan, CURRENT_PERIOD_START_PATH);
  const end = findVarintField(scan, CURRENT_PERIOD_END_PATH);
  if (start === undefined || end === undefined) return false;
  return start.value * 1000 <= nowMs && end.value * 1000 > nowMs;
};

const readPeriodBoundMs = (scan: ProtobufScan, path: string): number | null => {
  const field = findVarintField(scan, path);
  return field !== undefined && isTimestampSeconds(field.value) ? field.value * 1000 : null;
};

const resolveResetAtMs = (scan: ProtobufScan, nowMs: number): number | null => {
  const future = scan.varintFields
    .filter((field) => isTimestampSeconds(field.value) && field.value * 1000 > nowMs)
    .map((field) => ({ key: pathKey(field.path), ms: field.value * 1000 }));
  const billingPeriodEnd = future.filter((entry) => entry.key === BILLING_PERIOD_END_PATH);
  const candidates = billingPeriodEnd.length > 0 ? billingPeriodEnd : future;
  if (candidates.length === 0) return null;
  return Math.min(...candidates.map((entry) => entry.ms));
};

const buildPercentResult = (
  source: XaiWebBillingPercentSource,
  usedPercent: number,
  scan: ProtobufScan,
  nowMs: number
): XaiWebBillingParseResult => {
  const typeField = findVarintField(scan, CURRENT_PERIOD_TYPE_PATH);
  return {
    outcome: 'percent',
    usedPercent,
    source,
    periodType: resolvePeriodType(typeField !== undefined ? typeField.value : null),
    periodStartMs: readPeriodBoundMs(scan, CURRENT_PERIOD_START_PATH),
    periodEndMs: readPeriodBoundMs(scan, CURRENT_PERIOD_END_PATH),
    resetAtMs: resolveResetAtMs(scan, nowMs),
  };
};

/**
 * Parses a grpc-web-text `GetGrokCreditsConfig` response and adopts a percent
 * only under the validated shapes described in the module docs:
 * - a finite 0..100 float published on the wire (path ending in 1), or
 * - an implicit zero from a complete single-frame response with a recognized
 *   active current period and no fixed32 field anywhere.
 * Every other outcome is reported with a fixed reason code.
 */
export const parseXaiWebBillingResponse = (
  body: unknown,
  nowMs: number
): XaiWebBillingParseResult => {
  const text = typeof body === 'string' ? body : '';
  const bytes = decodeGrpcWebText(text);
  if (bytes === null) {
    return text.trim().length === 0
      ? { outcome: 'invalid', reason: 'empty' }
      : { outcome: 'invalid', reason: 'bad-base64' };
  }
  const frames = parseGrpcWebFrames(bytes);
  if (frames === null) return { outcome: 'invalid', reason: 'bad-frame' };

  const rawStatus = frames.trailerFields['grpc-status'];
  if (rawStatus === undefined) return { outcome: 'no-percent', reason: 'no-trailer' };
  const grpcStatus = Number(rawStatus);
  if (!Number.isInteger(grpcStatus) || grpcStatus < 0) {
    return { outcome: 'no-percent', reason: 'rpc-error', grpcStatus: -1 };
  }
  if (grpcStatus !== 0) return { outcome: 'no-percent', reason: 'rpc-error', grpcStatus };

  const scan: ProtobufScan = { fixed32Fields: [], varintFields: [], complete: true };
  for (const dataFrame of frames.dataFrames) {
    scanProtobuf(dataFrame, [], 0, scan);
  }

  const wireCandidates = scan.fixed32Fields.filter(
    (field) =>
      field.path[field.path.length - 1] === 1 &&
      Number.isFinite(field.value) &&
      field.value >= 0 &&
      field.value <= 100
  );
  if (wireCandidates.length > 0) {
    const wirePercent = wireCandidates.reduce((best, field) => {
      if (field.path.length !== best.path.length) {
        return field.path.length < best.path.length ? field : best;
      }
      return field.order < best.order ? field : best;
    });
    return buildPercentResult('grpc-wire', wirePercent.value, scan, nowMs);
  }
  if (!scan.complete) return { outcome: 'no-percent', reason: 'incomplete' };
  if (frames.dataFrames.length > 1) return { outcome: 'no-percent', reason: 'multi-frame' };
  if (scan.fixed32Fields.length > 0) return { outcome: 'no-percent', reason: 'fixed32-present' };
  if (!isRecognizedPeriodType(scan)) {
    return { outcome: 'no-percent', reason: 'unknown-period-type' };
  }
  if (!hasActiveCurrentPeriod(scan, nowMs)) {
    return { outcome: 'no-percent', reason: 'inactive-period' };
  }
  return buildPercentResult('grpc-implicit-zero', 0, scan, nowMs);
};
