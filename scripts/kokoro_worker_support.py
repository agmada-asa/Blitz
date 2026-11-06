"""Shared lifetime guard for local speech workers."""
import os
import time


def watch_parent(parent_pid):
    """Release models if the owning service exits, even during native inference."""
    while True:
        if os.getppid() != parent_pid or parent_pid == 1:
            os._exit(1)
        time.sleep(1)
