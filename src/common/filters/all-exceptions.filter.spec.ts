import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/index.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) };
  new AllExceptionsFilter().catch(exception, host as any);
  return { status: reply.status.mock.calls[0][0], body: reply.send.mock.calls[0][0] };
}

describe('AllExceptionsFilter', () => {
  it('passes an HttpException through as written', () => {
    expect(run(new ConflictException({ code: 'SLOT_TAKEN', error: 'taken' }))).toEqual({
      status: 409,
      body: { code: 'SLOT_TAKEN', error: 'taken' },
    });
  });

  it('maps known database errors without their internal message', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on users_username_key', { code: 'P2002', clientVersion: 't' });
    const { status, body } = run(err);
    expect(status).toBe(409);
    expect(JSON.stringify(body)).not.toContain('users_username_key');
  });

  it('never sends the message of an unexpected error', () => {
    expect(run(new Error('connect ECONNREFUSED 10.0.0.5:5432'))).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', error: 'internal server error' },
    });
  });
});
