# Topic organization

Prepared sources create project topics automatically as the local preparation
worker processes each bounded source chunk. The project workspace presents
those topics as an ordered learning path. Each topic is one section, its
concepts provide the section outline, and its explanation and question items
form the central walkthrough.

The desktop workspace keeps the learning path beside the walkthrough. Narrow
layouts move the same list into a `Sections` dialog. Concept rows show how many
questions have been answered, and sections mark when new learning items arrive.

Each topic remains available in the existing focused study flows:

- Selecting the topic opens its walkthrough inside the project.
- `Study` opens `/projects/:projectId/practice?topicId=...`.
- `Test` opens `/projects/:projectId/test?topicId=...`.

Topic titles can be renamed inline. The mutation trims and collapses whitespace,
limits titles to 140 characters, prevents case-insensitive duplicate names in a
project, and checks that the topic belongs to the project before writing.

`Exclude` removes a topic from the unfiltered home question feed. `Include`
reverses that choice. This preference does not delete topics, concepts,
learning items, or review history. The topic remains available in its project
walkthrough, Practice, and Test. The optional `topics.excludedFromFeed` field
treats missing values as included for rows created before this preference
existed.

Topic edits affect future feed selection; they do not rewrite generated content
or change source attribution. The walkthrough stores its last visible card in
browser storage. A concept completes when each distinct question has been
answered, regardless of correctness. Repeating an answer, opening an
explanation, or skipping a question does not advance that count. Correctness
continues to inform the separate review schedule stored in `conceptReviews`.
