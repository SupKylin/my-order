export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const assert = (condition, message, status = 400) => {
  if (!condition) throw new AppError(status, message);
};
