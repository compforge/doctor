/** @spec Core and Plugins may attach a stable code to a Doctor error and retain the original cause. */
export class DoctorError extends Error {
  readonly code?: string;

  constructor(message?: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.name = new.target.name;
    this.code = options?.code;
  }
}
