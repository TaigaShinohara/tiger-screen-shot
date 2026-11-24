/** Reject truncation and invalid chunk checksums before asking the browser to decode. */
export function isCompletePng(data: Buffer): boolean {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature)) return false;
  let offset = 8, first = true, idat = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > 0x7fffffff || length > data.length - offset - 12) return false;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (first && (type !== 'IHDR' || length !== 13)) return false;
    if (!first && type === 'IHDR') return false;
    const end = offset + 8 + length;
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end; index++) {
      crc ^= data[index];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(end)) return false;
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') return idat && length === 0 && end + 4 === data.length;
    first = false;
    offset = end + 4;
  }
  return false;
}
