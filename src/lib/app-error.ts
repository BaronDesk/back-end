export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", code = "BAD_REQUEST") {
    super(400, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", code = "UNAUTHORIZED") {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action", code = "FORBIDDEN") {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", code = "NOT_FOUND") {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists", code = "CONFLICT") {
    super(409, code, message);
  }
}
