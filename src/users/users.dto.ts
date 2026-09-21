import { Type } from 'class-transformer';
import { IsDate, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '../generated/prisma/index.js';

export class CreateGamerDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class CreateEmployeeDto {
  @IsUUID()
  branchId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsEnum([UserRole.EMPLOYEE, UserRole.MANAGER])
  role!: UserRole.EMPLOYEE | UserRole.MANAGER;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  hireDate?: Date;
}

export class UpdateUserRoleParamsDto {
  @IsUUID()
  id!: string;
}

export class UpdateUserRoleDto {
  @IsEnum(UserRole)
  role!: UserRole;
}

export class GetUserParamsDto {
  @IsUUID()
  id!: string;
}