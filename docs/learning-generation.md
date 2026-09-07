# Bounded learning generation

`lib/server/learning-generation.ts` is the generation boundary between one
`SourceChunk` and the portable learning rows that a caller can persist. It
does one chunk per call, so a job can save the chunk ID as its checkpoint and
resume without sending the whole source back to the model.

Call `generateLearningForChunk(chunk, generate, { signal })` with an injected
async text generator. The callback receives a prompt that labels the source as
untrusted factual material and the same optional abort signal. The function
expects exactly one plain JSON object from the callback. It does not unwrap
Markdown fences, scan event output, or search nested wrapper fields.

The returned batch contains a summary, up to 8 uniquely keyed concepts, and up
to 16 learning items. The prompt prefers 1 to 4 concepts so each concept can
receive one 120 to 220 word explanation followed by at least one question.
This pairing lets the project workspace present generated material as a paced
walkthrough. For factual chunks, both arrays must be populated and every
concept must be used by at least one item. A title-only or otherwise non-factual
chunk may return an explicit skipped batch with empty arrays and a summary
beginning `SKIPPED:`. Supported item types are `explain`, `single-choice`,
`multiple-answer`, and `true-false`. Recall and written-answer items are
excluded from this default generation path. Question items instruct the model
to craft plausible, domain-appropriate distractors and parallel option phrasing
that reflect realistic misconceptions or distinctions rather than senseless or
obviously fake filler answers.

Each generated item has `sourceChunkIds: [chunk.id]`. A different or fabricated
chunk ID is rejected, as are unknown concept keys, duplicate option IDs,
unknown answer IDs, duplicate answer IDs, incomplete question fields, and
answer fields attached to an `explain` item. Multiple-answer items require at
least two correct options and fewer correct options than the total option set.

The function returns only after parsing and cross-validating the complete
batch. It caps one chunk at 20,000 characters and one generated response at
250,000 UTF-8 bytes before parsing. It never writes to Convex and does not
silently truncate output. The caller maps each item’s `sourceChunkIds` to
persisted source IDs and resolves each `conceptKey` to a persisted concept
before using the existing learning mutations. The portable
`learningGenerationSchema` is exported from `lib/learning/generation.ts` for a
second validation gate in Convex.

An aborted request raises `LearningGenerationError` with code `aborted`,
including when the injected generator resolves after cancellation. Invalid
JSON and invalid data raise the same error class with code `invalid-output`.
