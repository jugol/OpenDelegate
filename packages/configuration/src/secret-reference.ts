const MAIN_SECRET_REFERENCE_PREFIX = "secret://main/";
const MAXIMUM_OPAQUE_SECRET_ID_LENGTH = 128;
const OPAQUE_SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

export interface CanonicalMainSecretReferenceValue {
  readonly secretRef: string;
}

export function isCanonicalMainSecretReference(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAIN_SECRET_REFERENCE_PREFIX.length + MAXIMUM_OPAQUE_SECRET_ID_LENGTH ||
    !value.startsWith(MAIN_SECRET_REFERENCE_PREFIX)
  ) {
    return false;
  }
  return OPAQUE_SECRET_ID.test(value.slice(MAIN_SECRET_REFERENCE_PREFIX.length));
}

export function isNullableCanonicalMainSecretReferenceValue(
  value: unknown,
): value is CanonicalMainSecretReferenceValue | null {
  if (value === null) {
    return true;
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, "secretRef")
  ) {
    return false;
  }
  return isCanonicalMainSecretReference((value as { readonly secretRef?: unknown }).secretRef);
}
