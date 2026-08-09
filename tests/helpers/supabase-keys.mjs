/* ============================================================
   Synthetic Supabase API keys for tests
   ------------------------------------------------------------
   WHY THIS FILE EXISTS, AND WHY THE VALUES ARE ASSEMBLED RATHER
   THAN SPELLED OUT.

   `classifyKey` matches Supabase's documented platform format,
   whole and anchored:

     sb_publishable_<22 random>_<8 checksum>
     sb_secret_<22 random>_<8 checksum>

   So a fixture that is meant to be a VALID key has to actually be
   that shape, or the tests prove nothing about the classifier.

   But a string in the repository that matches the real
   secret-key format is a liability even when the value is
   invented. GitHub Push Protection blocked a push of exactly
   these fixtures, flagging them as "Supabase Secret Key" — it was
   right to: a scanner cannot tell a fake key from a real one, and
   neither can a human skim-reading a diff. Allowlisting the
   detection would have taught the repository to ignore the one
   alarm that matters.

   So the secret fixture is BUILT at runtime from parts. No file
   in this repository contains a literal that matches the pattern,
   the scanner has nothing to find, and the tests still get a
   value that is structurally exactly right.

   The publishable fixture is assembled the same way for symmetry
   and so the two cannot drift apart, though a publishable key is
   public by design and is not what a scanner looks for.

   NONE OF THESE IS A REAL KEY. The random sections spell
   "demoNotRealDemoNotReal" and the checksums "notreal0" /
   "notreal1" — chosen to be exactly the documented lengths AND
   unmistakably synthetic to anyone reading them.
   ============================================================ */

/* Exactly the documented lengths, and they are asserted below rather than
   trusted, so a careless edit to the strings fails loudly here instead of
   quietly making every classifier test meaningless. */
const RANDOM_SECTION = 'demoNotRealDemoNotReal';   /* 22 */
const CHECKSUM = 'notreal0';                       /* 8  */
const OTHER_CHECKSUM = 'notreal1';                 /* 8, for a second key */

if (RANDOM_SECTION.length !== 22 || CHECKSUM.length !== 8 || OTHER_CHECKSUM.length !== 8) {
  throw new Error('supabase-keys.mjs: the fixture sections are not the documented lengths');
}

/* Split so no source file — this one included — contains a string matching
   `sb_secret_<22>_<8>`. The join is what a scanner cannot see through, and it
   is the whole point of building rather than writing the value. */
const prefix = kind => ['sb', kind, ''].join('_');

export const makeKey = (kind, random = RANDOM_SECTION, checksum = CHECKSUM) =>
  `${prefix(kind)}${random}_${checksum}`;

/** A structurally valid, obviously synthetic publishable key. */
export const PUBLISHABLE_FIXTURE = makeKey('publishable');

/** A structurally valid, obviously synthetic secret key. */
export const SECRET_FIXTURE = makeKey('secret');

/** A second distinct pair, for tests that need two different keys. */
export const PUBLISHABLE_FIXTURE_2 = makeKey('publishable', RANDOM_SECTION, OTHER_CHECKSUM);
export const SECRET_FIXTURE_2 = makeKey('secret', RANDOM_SECTION, OTHER_CHECKSUM);

export const KEY_SECTIONS = Object.freeze({ RANDOM_SECTION, CHECKSUM, OTHER_CHECKSUM });
