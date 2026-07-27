/**
 * Client-safe flags only. Never import lib/constants.ts from here — that module
 * carries the embargoed BULL address and is server-only by construction.
 *
 * The literal `process.env.NEXT_PUBLIC_SHOW_ADDRESS` reference is required for
 * Next's build-time inlining; do not refactor it behind a variable.
 */
export const SHOW_ADDRESS = process.env.NEXT_PUBLIC_SHOW_ADDRESS === 'true';

/** Suffix form, for slots that already name which wallet they are. */
export const EMBARGO_SHORT = 'reveals at launch';

/** Rendered wherever the embargoed *deposit* address would otherwise appear. */
export const ADDRESS_EMBARGO_LABEL = `deposit address ${EMBARGO_SHORT}`;

/**
 * The ops wallet is a different wallet from the deposit wallet. Labelling its
 * empty slot "deposit address reveals at launch" tells a deployer the two lines
 * take the same value, which is exactly the mistake that cannot be undone.
 */
export const OPS_EMBARGO_LABEL = `ops address ${EMBARGO_SHORT}`;
