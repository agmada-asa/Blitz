# Topic organization

Prepared sources create project topics automatically as the local preparation
worker processes each bounded source chunk. The project topic list presents
those generated topics in a flat, compact list. It does not add a manual
hierarchy or reorder topics.

The list shows the first six topics by default. `Show all topics` reveals the
rest, and `Show fewer` returns to the shorter list. Each row keeps the topic
link and options menu within comfortable touch targets.

Each topic links to three existing flows:

- The topic title opens the home feed scoped to that project and topic.
- `Study` opens `/projects/:projectId/practice?topicId=...`.
- `Test` opens `/projects/:projectId/test?topicId=...`.

Topic titles can be renamed inline. The mutation trims and collapses whitespace,
limits titles to 140 characters, prevents case-insensitive duplicate names in a
project, and checks that the topic belongs to the project before writing.

`Exclude` removes a topic from the unfiltered home feed. `Include` reverses that
choice. This is a reversible topic preference, so it does not delete topics,
concepts, learning items, or review history. An explicitly selected topic
continues to appear in the home feed and remains available in Practice and
Test. The optional `topics.excludedFromFeed` field treats missing values as
included for rows created before this preference existed.

Topic edits affect future feed selection; they do not rewrite generated content
or change source attribution.
