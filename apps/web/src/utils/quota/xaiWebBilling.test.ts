import { describe, expect, it } from 'vitest';
import {
  decodeGrpcWebText,
  parseXaiWebBillingResponse,
  type XaiWebBillingParseResult,
} from './xaiWebBilling';
import {
  buildBillingConfig,
  concatBytes,
  encodeBase64,
  grpcFrame,
  grpcWebTextBillingBody,
  pbFixed32Field,
  pbKey,
  pbLenField,
  pbVarintField,
} from './xaiWebBillingFixtures';

// Captured 2026-09-27 via a bearer-only management api-call probe of
// https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig with
// content-type application/grpc-web-text. Contains billing structure only
// (period bounds, flags) — no credentials, identifiers, or PII.
const LIVE_BILLING_BODY =
  'AAAAAEgKRhIAGgAiDAi+o+PVBhDA7d23AioMCL6YiNYGEMDt3bcCQh4IAhIMCL6j49UGEMDt3bcCGgwIvpiI1gYQwO3dtwJYAWIAaAE=gAAAAA9ncnBjLXN0YXR1czowDQo=';
const LIVE_START_MS = 1_790_497_214_000; // 2026-09-27T08:20:14Z
const LIVE_END_MS = 1_791_102_014_000; // 2026-10-04T08:20:14Z

const ELIGIBLE_NOW_MS = 1_800_000_001_000;
const ELIGIBLE_START_SEC = 1_800_000_000;
const ELIGIBLE_END_SEC = 1_800_604_800;

const billingBody = (
  options: Parameters<typeof buildBillingConfig>[0] & { nowMs: number }
): XaiWebBillingParseResult =>
  parseXaiWebBillingResponse(grpcWebTextBillingBody(options), options.nowMs);

describe('decodeGrpcWebText', () => {
  it('decodes two separately padded base64 frames', () => {
    const bytes = decodeGrpcWebText(LIVE_BILLING_BODY);
    expect(bytes).not.toBeNull();
    expect(bytes?.length).toBe(97);
    expect(Array.from((bytes ?? new Uint8Array()).subarray(0, 5))).toEqual([0, 0, 0, 0, 72]);
  });

  it('decodes a single unpadded chunk and rejects malformed input', () => {
    expect(Array.from(decodeGrpcWebText('AAAAAA') ?? [])).toEqual([0, 0, 0, 0]);
    expect(decodeGrpcWebText('')).toBeNull();
    expect(decodeGrpcWebText('   \n  ')).toBeNull();
    expect(decodeGrpcWebText('ab*cd=')).toBeNull();
    expect(decodeGrpcWebText('A')).toBeNull();
    expect(decodeGrpcWebText('AB==')).toBeNull();
    expect(decodeGrpcWebText('AA==AA===')).toBeNull();
    expect(decodeGrpcWebText(`${LIVE_BILLING_BODY}${'A'.repeat(70_000)}`)).toBeNull();
  });
});

describe('parseXaiWebBillingResponse', () => {
  it('parses the live two-frame answer as an implicit weekly zero', () => {
    const result = parseXaiWebBillingResponse(LIVE_BILLING_BODY, LIVE_START_MS + 86_400_000);
    expect(result).toEqual({
      outcome: 'percent',
      usedPercent: 0,
      source: 'grpc-implicit-zero',
      periodType: 'weekly',
      periodStartMs: LIVE_START_MS,
      periodEndMs: LIVE_END_MS,
      resetAtMs: LIVE_END_MS,
    });
  });

  it('rejects malformed transport shapes', () => {
    expect(parseXaiWebBillingResponse('', 0)).toEqual({ outcome: 'invalid', reason: 'empty' });
    expect(parseXaiWebBillingResponse('not base64!', 0)).toEqual({
      outcome: 'invalid',
      reason: 'bad-base64',
    });
    const truncated = encodeBase64(grpcFrame(0, new Uint8Array(72)).subarray(0, 40));
    expect(parseXaiWebBillingResponse(truncated, 0)).toEqual({
      outcome: 'invalid',
      reason: 'bad-frame',
    });
  });

  it('validates the grpc trailer status', () => {
    const data = grpcWebTextBillingBody({ startSec: 1, endSec: 2, trailerStatus: 5 });
    expect(parseXaiWebBillingResponse(data, 0)).toEqual({
      outcome: 'no-percent',
      reason: 'rpc-error',
      grpcStatus: 5,
    });
    const dataOnly = encodeBase64(grpcFrame(0, pbLenField(1, new Uint8Array())));
    expect(parseXaiWebBillingResponse(dataOnly, 0)).toEqual({
      outcome: 'no-percent',
      reason: 'no-trailer',
    });
  });

  it('rejects unsupported frame flags and non-final or malformed trailers', () => {
    const config = pbLenField(
      1,
      buildBillingConfig({ startSec: ELIGIBLE_START_SEC, endSec: ELIGIBLE_END_SEC })
    );
    const trailer = (text: string) => grpcFrame(0x80, new TextEncoder().encode(text));

    expect(
      parseXaiWebBillingResponse(
        `${encodeBase64(grpcFrame(1, config))}${encodeBase64(trailer('grpc-status:0\r\n'))}`,
        ELIGIBLE_NOW_MS
      )
    ).toEqual({ outcome: 'invalid', reason: 'bad-frame' });
    expect(
      parseXaiWebBillingResponse(
        `${encodeBase64(trailer('grpc-status:0\r\n'))}${encodeBase64(grpcFrame(0, config))}`,
        ELIGIBLE_NOW_MS
      )
    ).toEqual({ outcome: 'invalid', reason: 'bad-frame' });
    expect(
      parseXaiWebBillingResponse(
        `${encodeBase64(grpcFrame(0, config))}${encodeBase64(
          trailer('grpc-status:0\r\ngrpc-status:0\r\n')
        )}`,
        ELIGIBLE_NOW_MS
      )
    ).toEqual({ outcome: 'invalid', reason: 'bad-frame' });
    expect(
      parseXaiWebBillingResponse(
        `${encodeBase64(grpcFrame(0, config))}${encodeBase64(trailer('grpc-message:ok\r\n'))}`,
        ELIGIBLE_NOW_MS
      )
    ).toEqual({ outcome: 'invalid', reason: 'bad-frame' });
  });

  it('adopts a wire-published percent even alongside an active period', () => {
    const result = billingBody({
      nowMs: ELIGIBLE_NOW_MS,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
      extraConfigFields: pbLenField(2, pbFixed32Field(1, 55)),
    });
    expect(result).toMatchObject({
      outcome: 'percent',
      usedPercent: 55,
      source: 'grpc-wire',
      periodType: 'weekly',
      periodStartMs: ELIGIBLE_START_SEC * 1000,
      periodEndMs: ELIGIBLE_END_SEC * 1000,
      resetAtMs: ELIGIBLE_END_SEC * 1000,
    });
  });

  it('refuses the implicit zero when any fixed32 field exists', () => {
    const result = billingBody({
      nowMs: ELIGIBLE_NOW_MS,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
      extraConfigFields: pbFixed32Field(9, 150),
    });
    expect(result).toEqual({ outcome: 'no-percent', reason: 'fixed32-present' });
  });

  it('refuses the implicit zero for incomplete protobuf', () => {
    const truncatedConfig = pbLenField(
      1,
      concatBytes(
        buildBillingConfig({ startSec: ELIGIBLE_START_SEC, endSec: ELIGIBLE_END_SEC }),
        pbKey(14, 2)
      )
    );
    const result = parseXaiWebBillingResponse(
      `${encodeBase64(grpcFrame(0, truncatedConfig))}${encodeBase64(grpcFrame(0x80, new TextEncoder().encode('grpc-status:0\r\n')))}`,
      ELIGIBLE_NOW_MS
    );
    expect(result).toEqual({ outcome: 'no-percent', reason: 'incomplete' });
  });

  it('does not adopt a wire-looking percent from an incomplete protobuf', () => {
    const result = billingBody({
      nowMs: ELIGIBLE_NOW_MS,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
      extraConfigFields: concatBytes(pbLenField(2, pbFixed32Field(1, 55)), pbKey(14, 2)),
    });
    expect(result).toEqual({ outcome: 'no-percent', reason: 'incomplete' });
  });

  it('refuses the implicit zero across multiple data frames', () => {
    const config = pbLenField(
      1,
      buildBillingConfig({ startSec: ELIGIBLE_START_SEC, endSec: ELIGIBLE_END_SEC })
    );
    const body = `${encodeBase64(grpcFrame(0, config))}${encodeBase64(
      grpcFrame(0, pbLenField(1, new Uint8Array()))
    )}${encodeBase64(grpcFrame(0x80, new TextEncoder().encode('grpc-status:0\r\n')))}`;
    const result = parseXaiWebBillingResponse(body, ELIGIBLE_NOW_MS);
    expect(result).toEqual({ outcome: 'no-percent', reason: 'multi-frame' });
  });

  it('refuses the implicit zero for unrecognized or inactive periods', () => {
    const unknownType = billingBody({
      nowMs: ELIGIBLE_NOW_MS,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
      type: 3,
    });
    expect(unknownType).toEqual({ outcome: 'no-percent', reason: 'unknown-period-type' });

    const futurePeriod = billingBody({
      nowMs: ELIGIBLE_START_SEC * 1000 - 1_000,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
    });
    expect(futurePeriod).toEqual({ outcome: 'no-percent', reason: 'inactive-period' });

    const expiredPeriod = billingBody({
      nowMs: ELIGIBLE_END_SEC * 1000 + 1_000,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
    });
    expect(expiredPeriod).toEqual({ outcome: 'no-percent', reason: 'inactive-period' });
  });

  it('refuses ambiguous duplicate current-period fields', () => {
    const result = billingBody({
      nowMs: ELIGIBLE_NOW_MS,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
      extraConfigFields: pbLenField(8, pbVarintField(1, 2)),
    });
    expect(result).toEqual({ outcome: 'no-percent', reason: 'unknown-period-type' });
  });

  it('treats a recognized monthly period as eligible', () => {
    const result = billingBody({
      nowMs: ELIGIBLE_NOW_MS,
      startSec: ELIGIBLE_START_SEC,
      endSec: ELIGIBLE_END_SEC,
      type: 1,
    });
    expect(result).toMatchObject({
      outcome: 'percent',
      usedPercent: 0,
      source: 'grpc-implicit-zero',
      periodType: 'monthly',
    });
  });
});
