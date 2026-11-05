// Muse's built-in sample: text to read aloud, then a hymn in bass clef with
// two verses. Words: John Newton (1779); tune: New Britain (1829). Both are
// in the public domain.
export const SAMPLE_NAME = 'Sample: Amazing Grace';

export const SAMPLE_MARKDOWN = `---
muse:
  text: 20
  lyrics: small
  notes: medium
  staves: 6
  clef: auto
---
# Amazing Grace

This is Muse's sample page. Read this paragraph aloud and the underline follows your voice; sing the hymn below and it follows the lyrics too. Click to pause or resume listening, and scroll to move by hand. Tap then hold for the menu: auto-scroll, text and music sizes, and the clef.

## Verses 1 and 2

\`\`\`abc
X:1
T:Amazing Grace
M:3/4
L:1/4
K:G clef=bass
D, | G,2 (B,/G,/) | B,2 A, | G,2 E, | D,2 D, | G,2 (B,/G,/) | B,2 A, | D3- | D2 B, |
w: A-maz-ing_ grace! How sweet the sound That saved a_ wretch like me!_ I
w: 'Twas grace that_ taught my heart to fear, And grace my_ fears re-lieved;_ How
D2 (B,/G,/) | B,2 A, | G,2 E, | D,2 D, | G,2 (B,/G,/) | B,2 A, | G,3- | G,2 |]
w: once was_ lost, but now am found; Was blind, but_ now I see._
w: pre-cious_ did that grace ap-pear The hour I_ first be-lieved._
\`\`\`
`;
