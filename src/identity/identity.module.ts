import { Module } from '@nestjs/common';
import { IdentityRepository } from './identity.repository.js';

@Module({ providers: [IdentityRepository], exports: [IdentityRepository] })
export class IdentityModule {}