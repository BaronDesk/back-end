import { SetMetadata } from '@nestjs/common';

import type { Role } from '../utils/scope.js';

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (...roles: Role[]) => SetMetadata(PERMISSIONS_KEY, roles);
