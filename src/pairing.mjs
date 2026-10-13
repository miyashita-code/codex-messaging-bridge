export const DEFAULT_PAIRING_CODE_TTL_MS = 3600000;

export function normalizePairingCodeTtlMs(value) {
  if (value === undefined) return DEFAULT_PAIRING_CODE_TTL_MS;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(Date.now() + value)) {
    throw new Error('pairingCodeTtlMs must be null or a positive safe duration in milliseconds');
  }
  return value;
}

export function pairingCodeExpiryNotice(ttlMs) {
  const ttl = normalizePairingCodeTtlMs(ttlMs);
  if (ttl === null) return 'このペアリングコードに有効期限はありません。';
  const units = [[86400000, '日'], [3600000, '時間'], [60000, '分'], [1000, '秒'], [1, 'ミリ秒']];
  const [duration, label] = units.find(([duration]) => ttl % duration === 0);
  return `有効期限は発行から${ttl / duration}${label}です。`;
}
