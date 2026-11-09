/**
 * Size limits for a Teach outline. Kept free of dependencies so the Convex
 * functions that validate outlines can share them with the Teach protocol.
 */

/** Most sections an outline may contain; longer units are split by the tutor's judgment. */
export const MAX_TEACH_SECTIONS = 12

/**
 * Most sections an outline may reach through lesson updates. Higher than
 * `MAX_TEACH_SECTIONS` because an update never removes a section, so a full
 * outline still needs room for the new topics late material brings in.
 */
export const MAX_UPDATED_TEACH_SECTIONS = 16

/** Most concept names one outline section may list. */
export const MAX_SECTION_CONCEPTS = 6
