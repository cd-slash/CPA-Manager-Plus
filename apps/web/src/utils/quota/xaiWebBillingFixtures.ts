/**
 * Test-only builders for grok.com grpc-web-text billing payloads. Mirrors the
 * live wire shape: base64-padded gRPC-web frames wrapping the billing config
 * protobuf (period bounds, weekly/monthly type, optional percent fields).
 * Never imported by production code.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const encodeBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) {
      out += '==';
      break;
    }
    out += BASE64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) {
      out += '=';
      break;
    }
    out += BASE64_ALPHABET[b2 & 63];
  }
  return out;
};

export const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const pbVarint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
};

export const pbKey = (fieldNumber: number, wireType: number): Uint8Array =>
  pbVarint((fieldNumber << 3) | wireType);

export const pbLenField = (fieldNumber: number, payload: Uint8Array): Uint8Array =>
  concatBytes(pbKey(fieldNumber, 2), pbVarint(payload.length), payload);

export const pbVarintField = (fieldNumber: number, value: number): Uint8Array =>
  concatBytes(pbKey(fieldNumber, 0), pbVarint(value));

export const pbFixed32Field = (fieldNumber: number, floatValue: number): Uint8Array => {
  const encoded = new Int32Array(new Float32Array([floatValue]).buffer)[0] | 0;
  return concatBytes(
    pbKey(fieldNumber, 5),
    Uint8Array.from([
      encoded & 0xff,
      (encoded >>> 8) & 0xff,
      (encoded >>> 16) & 0xff,
      (encoded >>> 24) & 0xff,
    ])
  );
};

export const grpcFrame = (flags: number, payload: Uint8Array): Uint8Array => {
  const header = new Uint8Array(5);
  header[0] = flags;
  header[1] = (payload.length >>> 24) & 0xff;
  header[2] = (payload.length >>> 16) & 0xff;
  header[3] = (payload.length >>> 8) & 0xff;
  header[4] = payload.length & 0xff;
  return concatBytes(header, payload);
};

const trailerFrame = (status: number): Uint8Array =>
  grpcFrame(0x80, new TextEncoder().encode(`grpc-status:${status}\r\n`));

/** Mirrors the live grok.com answer: config with billing bounds, a current
 * period (type, seconds+nanos bounds), and no percent fields. */
export const buildBillingConfig = (options: {
  startSec: number;
  endSec: number;
  type?: number;
  nanos?: number;
  extraConfigFields?: Uint8Array;
}): Uint8Array => {
  const { startSec, endSec, type = 2, nanos = 653_752_000, extraConfigFields } = options;
  const bounds = (seconds: number): Uint8Array =>
    concatBytes(pbVarintField(1, seconds), pbVarintField(2, nanos));
  return concatBytes(
    pbLenField(1, new Uint8Array()),
    pbLenField(2, new Uint8Array()),
    pbLenField(3, new Uint8Array()),
    pbLenField(4, bounds(startSec)),
    pbLenField(5, bounds(endSec)),
    pbLenField(
      8,
      concatBytes(
        pbVarintField(1, type),
        pbLenField(2, bounds(startSec)),
        pbLenField(3, bounds(endSec))
      )
    ),
    pbVarintField(11, 1),
    pbLenField(12, new Uint8Array()),
    pbVarintField(13, 1),
    ...(extraConfigFields ? [extraConfigFields] : [])
  );
};

/** Builds a grpc-web-text body: separately padded data + trailer frames. */
export const grpcWebTextBillingBody = (
  options: Parameters<typeof buildBillingConfig>[0] & { trailerStatus?: number }
): string =>
  encodeBase64(grpcFrame(0, pbLenField(1, buildBillingConfig(options)))) +
  encodeBase64(trailerFrame(options.trailerStatus ?? 0));
