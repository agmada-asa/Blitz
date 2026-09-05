# Notifications

`/notifications` combines ongoing work and recent results from source
preparation, research planning, research imports, card conversations, and
workspace chat. Each row links to its project, research dialog, or saved chat.
`/activity` redirects here so older links remain valid.

The query reads a bounded number of records for each status and returns project
names, task labels, progress, timestamps, and clipped errors. It does not return
source snapshots, generated replies, or worker logs. Ongoing timers measure
time since each request started, including queue time and retries. Finished
rows keep their recorded duration.

Unread state and delivered browser alerts are kept on the current device.
Opening the page marks visible results as read. If the user enables browser
alerts, Blitz announces newly completed or failed work while the app remains
open. Clicking an alert opens the matching destination. The first load records
existing results without announcing a backlog.
