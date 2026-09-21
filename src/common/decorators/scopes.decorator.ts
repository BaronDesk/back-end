import { SetMetadata } from '@nestjs/common';
import { Scope } from '../auth/scope.js';

export interface ScopeOptions { ownerParam?: string; branchParam?: string; }
export const SCOPES_KEY = 'scopes';
export const Scopes = (min: Scope, options: ScopeOptions = {}) => SetMetadata(SCOPES_KEY, { min, ...options });
