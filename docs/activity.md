# Activity

`/activity` reads the durable preparation queue so active work remains visible
when the user navigates away from a project. The read is bounded to six queued,
six leased, and six failed jobs per preparation, research-planning, source
download, and card-reply status, using each table's existing status and
creation index. It joins only project titles and source filenames or proposal
titles and returns progress fields and clipped error messages; source snapshots,
questions, replies, and worker logs are omitted from the activity response.
The four most recently created completed chat messages are also listed, so
users can reopen a saved reply after leaving the feed. `/chat` resolves the
attachment by project and item, independently of feed ordering.

The page explains once that preparation continues on the local Mac while it is
awake, even when the page is closed.

Elapsed time updates in the browser and stops at the recorded timestamp for
failed or completed jobs. It is time since the request was created, including
waiting and retries, rather than a completion estimate. The bounded list is
not an exhaustive history; project source lists remain the complete view.
