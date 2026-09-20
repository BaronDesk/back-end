import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2's Algorithm is an ambient `const enum`, which isolatedModules
// forbids referencing directly. 2 is Algorithm.Argon2id (also the library default).
const ARGON2ID = 2;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, { algorithm: ARGON2ID });
  }

  verify(passwordHash: string, plain: string): Promise<boolean> {
    return verify(passwordHash, plain);
  }
}
