export interface OffsetCursorPayload {
  v: 1;
  offset: number;
}

export function encodeOffsetCursor(offset: number): string {
  const safeOffset = Math.max(0, Math.floor(offset));
  return Buffer.from(JSON.stringify({ v: 1, offset: safeOffset } satisfies OffsetCursorPayload), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | null | undefined): { ok: true; offset: number } | { ok: false; message: string } {
  if (cursor === undefined || cursor === null || cursor === '') {
    return { ok: true, offset: 0 };
  }
  if (typeof cursor !== 'string' || cursor.length > 256) {
    return { ok: false, message: '分页游标格式无效' };
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<OffsetCursorPayload>;
    if (!decoded || decoded.v !== 1 || typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      return { ok: false, message: '分页游标内容无效' };
    }
    return { ok: true, offset: decoded.offset };
  } catch {
    return { ok: false, message: '分页游标解析失败' };
  }
}
