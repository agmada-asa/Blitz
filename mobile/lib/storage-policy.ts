/** Defines pure ownership decisions for migrating legacy native storage. */

/** Describes whether a legacy record can be claimed without remapping ownership. */
export function legacyMigrationAction(
  existingOwner: string | null,
  hasLegacyData: boolean,
  serverUrl?: string
): "claim" | "skip" | "orphan" {
  if (existingOwner && existingOwner !== serverUrl) return "skip"
  if (serverUrl?.trim() && hasLegacyData) return "claim"
  return "orphan"
}
