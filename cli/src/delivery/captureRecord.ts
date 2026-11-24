import { createHash } from 'node:crypto';
import { readPngInfo } from '../verify/png.js';
import { isCompletePng } from './png.js';

export interface CaptureRecord {
  version: 1;
  group: string;
  screen: string;
  format: string;
  locale: string;
  app: string;
  device: { name: string; platform: 'ios' | 'android'; kind: 'simulator' | 'emulator' | 'phone'; model?: string };
  width: number;
  height: number;
  sha256: string;
  capturedAt: string;
  mode: 'launch' | 'link' | 'current_screen';
  warnings: string[];
}

export function capturePixels(bytes: Buffer) {
  const png = readPngInfo(bytes);
  if (!png || !isCompletePng(bytes)) throw new Error('Capture did not return a complete PNG.');
  return {
    width: png.width, height: png.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function matchesCaptureDevice(format: string, device: CaptureRecord['device']): boolean {
  if (format === 'android' || format.startsWith('tablet-')) return device.platform === 'android';
  const model = device.model ?? device.name;
  return device.platform === 'ios' && (format.startsWith('ipad-') ? /ipad/i.test(model) : /iphone/i.test(model));
}

export function readCaptureRecord(raw: Buffer, expected: Pick<CaptureRecord, 'group' | 'screen' | 'format' | 'locale'> & { bytes: Buffer }): CaptureRecord {
  const record = JSON.parse(raw.toString('utf8')) as CaptureRecord;
  const { width, height, sha256 } = capturePixels(expected.bytes);
  if (record?.version !== 1 || record.group !== expected.group || record.screen !== expected.screen ||
      record.format !== expected.format || record.locale !== expected.locale ||
      record.width !== width || record.height !== height || record.sha256 !== sha256 ||
      typeof record.app !== 'string' || !record.app || typeof record.device?.name !== 'string' ||
      !['simulator', 'emulator', 'phone'].includes(record.device.kind) ||
      !matchesCaptureDevice(record.format, record.device) ||
      !['launch', 'link', 'current_screen'].includes(record.mode) ||
      typeof record.capturedAt !== 'string' || !Number.isFinite(Date.parse(record.capturedAt)) ||
      !Array.isArray(record.warnings) || record.warnings.some((warning) => typeof warning !== 'string')) {
    throw new Error('Capture record does not match the requested screen and input.');
  }
  return record;
}
