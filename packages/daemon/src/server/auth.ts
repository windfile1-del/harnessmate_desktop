import crypto from 'node:crypto';
import type { PairedDevice } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';

export interface ActivePairingCode {
  code: string;
  expiresAt: number;
}

export interface AuthPrincipal {
  kind: 'local' | 'device';
  device?: PairedDevice;
}

export class RemoteAuthService {
  private activePairing: ActivePairingCode | null = null;

  constructor(
    private readonly store: HarnessMateStore,
    private readonly localToken: string,
  ) {}

  generatePairingCode(ttlMs = 5 * 60_000): ActivePairingCode {
    const code = String(crypto.randomInt(100_000, 999_999));
    this.activePairing = {
      code,
      expiresAt: Date.now() + ttlMs,
    };
    return this.activePairing;
  }

  getActivePairing(): ActivePairingCode | null {
    if (!this.activePairing) return null;
    if (Date.now() > this.activePairing.expiresAt) {
      this.activePairing = null;
      return null;
    }
    return this.activePairing;
  }

  exchangePairingCode(
    code: string,
    deviceName: string,
    platform: 'android' | 'ios' | 'web',
  ): { device: PairedDevice; token: string } {
    const active = this.getActivePairing();
    if (!active || active.code !== code.trim()) {
      throw new Error('Invalid or expired pairing code');
    }

    // One-time code consumed immediately upon exchange
    this.activePairing = null;

    const rawToken = `hmd_${crypto.randomBytes(24).toString('base64url')}`;
    const tokenHash = hashToken(rawToken);
    const device = this.store.createPairedDevice({
      id: `dev_${crypto.randomBytes(6).toString('hex')}`,
      deviceName: deviceName.trim(),
      platform,
      tokenHash,
      createdAt: Date.now(),
    });

    return { device, token: rawToken };
  }

  listDevices(): PairedDevice[] {
    return this.store.listPairedDevices();
  }

  revokeDevice(deviceId: string): boolean {
    return this.store.revokePairedDevice(deviceId);
  }

  authenticate(remoteAddress: string | undefined, bearerToken: string | undefined): AuthPrincipal | null {
    const isLoopback = isLoopbackAddress(remoteAddress);

    if (bearerToken) {
      if (timingSafeEquals(bearerToken, this.localToken)) {
        return { kind: 'local' };
      }
      const device = this.store.findActiveDeviceByTokenHash(hashToken(bearerToken));
      if (device) {
        return { kind: 'device', device };
      }
      if (!isLoopback) {
        return null;
      }
    }

    // Loopback requests from local Desktop UI / Electron are permitted without remote device pairing
    if (isLoopback) {
      return { kind: 'local' };
    }

    return null;
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isLocalBrowserRequest(headers: {
  host?: string;
  origin?: string;
  'sec-fetch-site'?: string | string[];
}): boolean {
  if (!headers.host) return false;
  try {
    const host = new URL(`http://${headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
    if (!headers.origin) return headers['sec-fetch-site'] !== 'cross-site';
    if (headers.origin === host.origin) return true;
    const devOrigin = process.env.HARNESSMATE_DEV_URL;
    return headers.origin === (devOrigin ? new URL(devOrigin).origin : 'http://127.0.0.1:5173')
      || (!devOrigin && headers.origin === 'http://localhost:5173');
  } catch {
    return false;
  }
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr === 'localhost'
  );
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
