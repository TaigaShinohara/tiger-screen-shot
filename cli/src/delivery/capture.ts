import fs from 'node:fs';
import path from 'node:path';
import { flagBool, flagNumber, flagString } from '../args.js';
import type { CommandContext } from '../context.js';
import { EXIT, type ExitCode, OsgError, usageError } from '../errors.js';
import { emit } from '../log.js';
import { desktopRequest } from '../commands/desktopCall.js';
import { readCaptureTarget } from './spec.js';
import { capturePixels, matchesCaptureDevice, type CaptureRecord } from './captureRecord.js';
import type { CaptureDevice, CaptureDevices, CaptureApp } from '@/lib/capture/types';

type DesktopCapture = {
  pngDataUrl: string;
  width: number;
  height: number;
  device: CaptureDevice;
  warnings?: string[];
};

export async function captureInput(ctx: CommandContext, spec: string, output: string): Promise<number> {
  const { flags } = ctx.args;
  const required = (key: string) => {
    const value = flagString(flags, key)?.trim();
    if (!value) throw usageError(`Pass --${key}.`);
    return value;
  };
  const target = readCaptureTarget(spec, required('group'), required('screen'));
  const deviceId = required('device');
  const app = required('app');
  const port = flagNumber(flags, 'port');
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw usageError('Pass the desktop MCP port with --port.');
  const current = flagBool(flags, 'current-screen');
  const launch = flagBool(flags, 'launch');
  const link = flagString(flags, 'screen-url');
  if (Number(current) + Number(launch) + Number(!!link) !== 1) throw usageError('Choose --launch, --screen-url or --current-screen.');
  if (link && !/^[a-z][a-z0-9+.-]*:\/\//i.test(link)) throw usageError('Use a verified app screen link with --screen-url.');
  if (fs.existsSync(output) || !fs.statSync(path.dirname(output)).isDirectory()) throw usageError('Choose a new capture directory inside an existing parent.');
  const { group, screen, format, locale } = target;
  const stop = (code: string, message: string, next: string, exit: ExitCode = EXIT.usage) => {
    emit({ status: 'capture_blocked', issues: [{ group, screen, code, message, next }] });
    return exit;
  };
  if (flagBool(flags, 'dry-run')) {
    emit({ status: 'planned', ...target, output, mode: current ? 'current_screen' : link ? 'link' : 'launch', app, writes: false });
    return EXIT.ok;
  }
  const token = process.env.OSG_DESKTOP_MCP_TOKEN ?? process.env.OSG_MCP_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return stop('desktop_auth_required', 'The desktop MCP bearer token is unavailable.', 'connect_desktop');
  const call = (name: string, args: object) => desktopRequest(port, token, name, args, 180);

  let stage = 'list_devices';
  let record: CaptureRecord, bytes: Buffer;
  try {
    const listed = await call('list_capture_devices', {}) as CaptureDevices;
    const platform = format === 'android' || format.startsWith('tablet-') ? listed.android : listed.ios;
    if (platform.missing || platform.error) return stop('device_discovery_unavailable', platform.error ?? `Capture requires ${platform.missing}.`, 'check_capture_setup');
    const device = platform.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return stop('device_not_found', 'The requested device is not available on the target platform.', 'list_capture_devices');
    if (!matchesCaptureDevice(format, device)) return stop('device_mismatch', 'The device does not match the selected screenshot format.', 'choose_matching_device');
    if (device.state !== 'running') {
      return stop(`device_${device.state}`, `The capture device is ${device.state}.`,
        device.state === 'unauthorized' ? 'authorize_device' : device.state === 'offline' ? 'reconnect_device' : 'start_or_wait_for_device');
    }
    stage = 'list_apps';
    const apps = await call('list_capture_devices', { device: deviceId }) as { apps?: CaptureApp[] };
    const installed = apps.apps?.find((candidate) => candidate.id === app);
    if (!installed) return stop('app_not_installed', 'The requested app is not installed on the capture device.', 'prepare_app');
    if (current && !installed.running) return stop('screen_not_ready', 'Open the app and navigate to the requested screen.', 'position_app_on_screen');

    stage = 'take_screenshot';
    const shot = await call('capture_screenshot', {
      device: deviceId, locale, tidyStatusBar: false, returnOriginal: true,
      ...(current ? {} : { app }), ...(link ? { screenUrl: link } : {}),
    }) as DesktopCapture;
    stage = 'validate_screenshot';
    if (shot.device?.id !== deviceId || !matchesCaptureDevice(format, shot.device)) {
      return stop('device_mismatch', 'Capture returned a screenshot from a different device.', 'choose_matching_device');
    }
    const encoded = typeof shot.pngDataUrl === 'string' && /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(shot.pngDataUrl);
    if (!encoded) return stop('original_unavailable', 'The desktop did not return the original PNG. Use a desktop build with delivery Capture support.', 'update_desktop');
    bytes = Buffer.from(encoded[1], 'base64');
    const pixels = capturePixels(bytes);
    if (pixels.width !== shot.width || pixels.height !== shot.height) return stop('capture_size_mismatch', 'The captured PNG dimensions do not match the desktop result.', 'capture_again');
    const { name, kind, platform: devicePlatform, model } = device;
    record = {
      version: 1, group, screen, format, locale, app, device: { name, kind, platform: devicePlatform, ...(model ? { model } : {}) },
      ...pixels, capturedAt: new Date().toISOString(),
      mode: current ? 'current_screen' : link ? 'link' : 'launch', warnings: shot.warnings ?? [],
    };
  } catch (error) {
    if (error instanceof OsgError && error.detail?.agentCode === 'permission_denied') throw error;
    const message = error instanceof Error ? error.message : 'Capture failed.';
    return stop(stage === 'take_screenshot' ? 'capture_failed' : stage === 'validate_screenshot' ? 'invalid_capture' : 'desktop_unavailable',
      message, stage === 'take_screenshot' ? 'check_device_and_screen' : stage === 'validate_screenshot' ? 'capture_again' : 'check_desktop_connection',
      EXIT.driver);
  }

  fs.mkdirSync(output, { mode: 0o700 });
  const input = path.join(output, 'original.png'), capture = path.join(output, 'capture.json');
  fs.writeFileSync(input, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(capture, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  emit({ status: 'captured', input, inputFormat: format, inputLocale: locale, capture, record, next: 'review_source_and_update_spec' });
  return EXIT.ok;
}
