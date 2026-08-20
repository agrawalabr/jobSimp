1) Post-send UI — merge a local stub (count: 0) and repaint immediately. Use the Outreach refresh button when you want a live Cloud Run pull.
2) IndexedDB — store keys/meta + snippet only (gmailId, threadId, to, subject, beaconId, sentAt, attached). The reader loads the thread by id. Sidebar snippet is the latest message in that thread (threadId was previously dropped by the DAO field list).
3) Reply / Forward — open JobSimp compose (Reply fills To + Re: + quote; Forward leaves To empty + Fwd: + quote + signature).
4) Attachments — broader Gmail part walk, and threadId is actually persisted so the reader can load the real thread (including the PDF).
5) Gmail Refresh — match act="20" / aria / tooltip / title containing “Refresh”, then beacon.list + redecorate list or open view. Console should show mail-track 0.1.31.
6) Open-view pill — mount in `.bHJ`; match exact `legacy-last-message-id` ↔ `beacon.meta.gmailMessageId`; if that attr is absent, fall back to latest Sent body beacon-id.
8) Double signature — composer already injects the signature; send was appending it again. Send no longer re-appends when the body is already signed. Reader <p> spacing is tighter.