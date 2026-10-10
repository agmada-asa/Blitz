# Notifications

`/notifications` combines ongoing work and recent results from practice
question banks, exam papers (past paper reading and mock writing), exam
marking, research planning, research imports, card conversations, and
workspace chat. Each row links to where the result is used: the module's
Practice page, the exam paper, the marked attempt, the research dialog, or the
saved chat. Teach chats never notify; the lesson itself shows progress.
`/activity` redirects here so older links remain valid.

The query reads a bounded number of records for each status and returns project
names, task labels, progress, timestamps, and clipped errors. It does not return
source snapshots, generated replies, or worker logs. Question bank, paper, and
marking runs share a ten minute lease: the web client passes its minute clock
as `now`, and a run still marked running past its lease shows as failed so it
can be retried instead of spinning forever. Ongoing timers measure
time since each request started, including queue time and retries. Finished
rows keep their recorded duration.

Unread state and delivered browser alerts are kept on the current device.
Opening the page marks visible results as read. If the user enables browser
alerts, Blitz announces newly completed or failed work while the app remains
open. Clicking an alert opens the matching destination. The first load records
existing results without announcing a backlog.
