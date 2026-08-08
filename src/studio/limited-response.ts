function declaredContentLength(response: Response): number | null {
  const value = response.headers?.get("content-length");
  if (!value) return null;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

async function assertDeclaredSize(
  response: Response,
  maxBytes: number,
  errorMessage: string,
): Promise<void> {
  const length = declaredContentLength(response);
  if (length !== null && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(errorMessage);
  }
}

async function readStreamBytesWithLimit(
  response: Response,
  maxBytes: number,
  errorMessage: string,
): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  errorMessage: string,
): Promise<string> {
  await assertDeclaredSize(response, maxBytes, errorMessage);
  const bytes = await readStreamBytesWithLimit(response, maxBytes, errorMessage);
  if (bytes) return new TextDecoder().decode(bytes);

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(errorMessage);
  }
  return text;
}

export async function readResponseBlobWithLimit(
  response: Response,
  maxBytes: number,
  errorMessage: string,
): Promise<Blob> {
  await assertDeclaredSize(response, maxBytes, errorMessage);
  const bytes = await readStreamBytesWithLimit(response, maxBytes, errorMessage);
  if (bytes) {
    return new Blob([bytes.buffer as ArrayBuffer], {
      type: response.headers?.get("content-type") ?? "",
    });
  }

  const blob = await response.blob();
  if (blob.size > maxBytes) throw new Error(errorMessage);
  return blob;
}
