# Written practice

Written practice is a writing activity the learner opens on purpose, from `Written answers` on the Practice screen (`/projects/[projectId]/write`, optional `topicId`). Each prompt asks the learner to explain a concept in their own words, then compare their answer with a reference taken from the material. Nothing is scored automatically.

## Prompts

Prompts come from the module's `explain` learning items that have a body. Each one reads "Explain <title> in your own words." and lists the sources behind it; the item's body is the reference.

An activity has at most five prompts, taken in saved order from a scan of at most 2,000 items. The next activity carries on after the last prompt finished, and starts again from the beginning only after the real end of the module. If the scan limit is reached before a usable prompt, it returns an error instead of starting over. A scope with no prompts returns `null` and creates nothing.

## Saving and comparing

- `api.writing.getLatest({ projectId, topicId? })` returns the latest activity in that scope.
- `api.writing.start({ projectId, topicId?, requestId })` resumes the latest unfinished activity or starts a new one. Replaying the same `requestId` returns the same activity.
- `api.writing.saveAnswer({ projectId, activityId, itemId, answer, reveal })` saves a draft, or with `reveal` compares it.

Drafts need an explicit save, and saving a draft doesn't return the reference. Comparing shows the reference and locks the answer. Each activity keeps a snapshot of its prompts and references, so editing an item later doesn't change an activity already started. Writes check that the activity, item and scope all belong to the project.

A reload resumes the first unfinished prompt; a comparison stays on screen until **Next**. Written practice creates no study events, concept reviews, grades or generation jobs.
