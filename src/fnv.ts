export function fnv1a32(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index++) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function u16LittleEndian(values: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    if (values[index] > 65535) throw new Error(`Iteration count exceeds u16 limit: ${values[index]}`);
    view.setUint16(index * 2, values[index], true);
  }
  return bytes;
}
