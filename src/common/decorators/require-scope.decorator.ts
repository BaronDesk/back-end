import { SetMetadata } from '@nestjs/common';

import type { Scope } from '../utils/scope.js';

export const REQUIRE_SCOPE_KEY = 'requireScope';
export const RequireScope = (scope: Scope) => SetMetadata(REQUIRE_SCOPE_KEY, scope);
