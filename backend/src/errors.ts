export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new AppError(400, "BAD_REQUEST", msg);
export const unauthorized = (msg = "unauthorized") =>
  new AppError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "forbidden") => new AppError(403, "FORBIDDEN", msg);
export const notFound = (msg = "not found") => new AppError(404, "NOT_FOUND", msg);
export const conflict = (msg: string) => new AppError(409, "CONFLICT", msg);
