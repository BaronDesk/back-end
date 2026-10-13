import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { caller, createHarness, STATION, type Harness } from './session-billing.harness-spec.js';
import { SessionsService } from './sessions.service.js';

describe('SessionsService', () => {
  let harness: Harness;
  let port: Harness['port'];
  let service: SessionsService;

  beforeEach(() => {
    harness = createHarness();
    ({ port } = harness);
    service = harness.sessions;
  });

  afterEach(() => harness.destroy());

  describe('login', () => {
    it('registers itself as the gateway login handler', () => {
      expect(port.current).toBe(service);
    });
  });

  describe('facade', () => {
    const now = new Date();
    const cases: [keyof SessionsService, keyof Harness, string, unknown[]][] = [
      ['start', 'login', 'start', [caller(), 'res-1']],
      ['checkIn', 'login', 'checkIn', ['g1', 'res-1']],
      ['pinsForGamer', 'login', 'pinsForGamer', ['g1']],
      ['login', 'login', 'login', [STATION, 'pin', '123456']],
      ['lease', 'login', 'lease', [STATION, 's1']],
      ['quote', 'metering', 'quote', ['g1', 'b1', true, now, 30]],
      ['committedCents', 'metering', 'committedCents', ['g1', now, 'res-1']],
      ['assertAffordable', 'metering', 'assertAffordable', [{ gamerProfileId: 'g1', branchId: 'b1', isWalkIn: true, start: now, minutes: 30 }]],
      ['extendOptions', 'extensions', 'extendOptions', ['g1', 'res-1']],
      ['extend', 'extensions', 'extend', ['g1', 'res-1', 30]],
      ['list', 'queries', 'list', [caller(), { limit: 50 }]],
      ['currentForGamer', 'queries', 'currentForGamer', ['user-g1']],
      ['get', 'queries', 'get', [caller(), 's1']],
      ['end', 'stationLink', 'end', [caller(), 's1', 'closing']],
      ['forceClose', 'stationLink', 'forceClose', [caller(), 's1', 'desk']],
      ['unlockFor', 'stationLink', 'unlockFor', [STATION]],
      ['closeForShutdown', 'stationLink', 'closeForShutdown', [STATION]],
      ['retireMachine', 'stationLink', 'retireMachine', ['m1']],
      ['markStaffLock', 'stationLink', 'markStaffLock', [STATION]],
      ['lockWhileOffline', 'stationLink', 'lockWhileOffline', [STATION]],
      ['endWhileOffline', 'stationLink', 'endWhileOffline', [STATION, 'closing']],
      ['reconcile', 'stationLink', 'reconcile', [STATION, { locked: true, sessionId: 's1' }]],
      ['lockForRunout', 'runout', 'lockForRunout', ['s1']],
      ['warnLowBalance', 'runout', 'warnLowBalance', ['s1']],
      ['sweep', 'sweep', 'sweep', []],
    ];

    it.each(cases)('%s() hands off to %s.%s() and returns its result', async (method, target, targetMethod, args) => {
      const result = { from: `${String(target)}.${targetMethod}` };
      const spy = vi.spyOn(harness[target] as any, targetMethod).mockResolvedValue(result);
      await expect((service as any)[method](...args)).resolves.toBe(result);
      expect(spy).toHaveBeenCalledWith(...args);
    });
  });
});
