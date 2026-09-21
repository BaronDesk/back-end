import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { IdentityModule } from '../identity/identity.module.js';

@Module({ imports: [IdentityModule], controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}