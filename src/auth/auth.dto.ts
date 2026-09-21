import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class LogoutDto {
  // jti of the refresh token to revoke. Optional: if omitted, revokes the
  // refresh token that matches the caller's current session where possible.
  @IsOptional()
  @IsUUID()
  jti?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}