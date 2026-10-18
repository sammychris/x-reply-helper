SAMMY'S REPLY HELPER + AUTOPILOT FOR X  (Chrome extension, Windows PC)  v2.3.3

WHAT IT DOES
- Adds a "Reply ideas" button under every post on x.com.
- Click it: it reads the post's text and images, then shows 3 reply ideas in your voice.
- You can edit an idea right in the box, then press "Use": it opens X's reply box and types it in.
- YOU press X's Reply button. Nothing is ever posted on its own.
- Bottom-left badge counts the replies you sent today against your goal.
- "Draft next 10" (bottom left) drafts ideas for the next 10 posts in your feed at once. Then just go down: Use > Reply.
- Open a post on its own page to get better ideas: it also reads up to 10 replies people left, to understand the context and video.
- If a post is bait, a giveaway, a scam, a tragedy or politics, it suggests skipping it.

INSTALL (2 minutes)
1. Unzip this folder somewhere you'll keep it (e.g. Documents\x-reply-helper).
2. In Chrome, open:  chrome://extensions
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and pick the x-reply-helper folder.
5. Click the extension's icon (puzzle piece > Sammy's Reply Helper) to open Settings.

API KEY
- Get one at https://console.anthropic.com (API Keys). This is separate from your
  Claude subscription and is pay-as-you-go. Set a monthly spend limit there.
- Paste it in Settings and press Save. The key stays in your Chrome only.
- Default model is claude-haiku-5-5 (fast and cheap). You can change it in Settings.

POST PICKER (your 500 text posts)
- 1,563 posts are ALREADY INSIDE: the first 500 (X-Text-Bank.xlsx) + 1,063 new ones (X-Conversation-Bank-1000.xlsx).
  New posts show an image idea under them. You don't need to import anything.
- Green "Pick a post" button (bottom left on x.com) shows 10 random posts you haven't used yet.
- Edit one if you like, press "Use": X's post box opens with it filled in. You press Post.
- Once you press Post, that one is marked as used and never shows again. "Show 10 more" gives a new 10.
- Settings > Your post bank: add more posts (.xlsx like X-Text-Bank.xlsx, .csv with a "Post" column, or .txt one per line),
  download the list of what you've posted, or reset.

GOOGLE GEMINI BACKUP
- Get a free key at https://aistudio.google.com (Get API key) and paste it in Settings.
- "Claude first, Gemini as backup": if Claude has no key, no credit or an error, Gemini writes the replies.
- Each panel shows which AI wrote it. Default Gemini model: gemini-3.1-flash-lite (the one from your old extension) (change it in Settings).
- Busy/overloaded errors are retried 3 times automatically. The reviewer is skipped when Gemini is used, to save your free requests.
- Gemini also reads the images. Free-tier limits are set by Google and can be low.

IMAGES ON/OFF
- Settings > "Send the post's images to the AI". On = reads pictures (best for memes and movie screenshots).
  Off = text only (faster and cheaper). The panel says "Images are off" when it skipped them.

TIPS
- Edit the "Your voice" box in Settings to sound more like you.
- If X changes its page and the button disappears, tell Claude: the fix is usually one line.


AUTOPILOT (new in 2.0)
Batches of 10-50 posts: it reads them, writes replies, you review the batch, then it posts them for you.

1. FILL THE QUEUE (any mix):
   - "🤖 Collect" (bottom left on x.com): scrolls the page you're on (home feed, a search, a list) and picks posts
     that pass your filters: topics, keywords, text/image/video, max age, max replies, skip words/accounts.
     Favourites always go first. Your own posts, ads and posts already done are skipped.
   - ➕ next to the Like button on any post: adds that post by hand.
   - Control center > "Add links": paste any number of X post links (or import a .txt).
   - In a group chat: "📍 Set start point", click the first message to start from, then "🔗 Grab new links".
     Next time it only grabs links posted since the last grab.
   Each post has Reply / Like / Repost boxes. Defaults per source are in "Default actions"
   (chat links default to Like + Repost, no reply).

2. "Write replies": a small working window opens and visits each post (keep it open, don't minimise it).
   It reads the post, up to 10 replies, picture descriptions and a few video frames.
   Pictures are described ONCE by the "reader" AI (small size), then the writer and reviewer only get text.
   Gemini writes 3 replies, Claude scores them and picks the most natural one. A free check also marks down
   dashes, semicolons, hashtags, emoji spam and your "words that sound like AI" list.
   Optional: ask Grok on videos it still doesn't understand (experimental, capped per day).

3. REVIEW: each post shows the chosen reply (edit it), the other drafts (click to swap) and a score.
   Low scores, "skip" suggestions and posts it didn't understand come UNTICKED with a warning.

4. "Continue": posts the ticked ones one by one: random gap (default 8-20 sec), a rest after every 10
   (default 3 min). If X shows an error it rests 10 min and slows down; a second error pauses everything.
   Turn on "Keep going" to collect and write the next batch automatically after posting (you still review).

Everything it did is in the Done and Log tabs. Done posts are never queued again.
Control center opens from the "Control center" button on x.com, or by itself when you add posts.

CHANGES IN 2.1
- Filters are OFF by default. "Use filters" turns them on, and each filter has its own switch
  (age, replies, words, accounts, topics/keywords, post types, ads, your own posts). Only "already done" always applies.
- "Filtered out" tab: every post a filter left out, with the reason and an "Add to queue" button.
- Review: every post comes ticked. Weak ones only get unticked if you turn on "Untick weak replies for me" (AI section).
- "Reply all / Like all / Repost all": tick or untick that action on every post in the list.
  Turning Reply on for a post with no reply sends it back to the queue: press Write replies.
- Speed: "Finish the batch in X minutes" (default 10). Every gap is different but the batch ends on time.
  If the time is too short, it says the fastest possible time (about 5 s per post). Or use "Gap between posts".

CHANGES IN 2.2
- Runs in the extension's background: you can close or hide the control center and it keeps going.
  Keep Chrome open and the small working window on screen (not minimised).
- Posting order: open the post → wait on it (every wait different) → like / repost / reply → straight to the next.
- Moves between posts inside X (like tapping a post) instead of reloading the page each time; falls back to a
  normal page load if that ever fails.
- Never replies twice: if your reply is already under a post (you replied by hand, or Chrome stopped mid-way),
  the reply is skipped and marked "already replied".
- X's "rate limit" page is recognised: Autopilot pauses and tells you to wait.
- "Leave out ads" and "Leave out my own posts" now work even with filters off (switch them off if you want them).
- Chat start point keeps working when you scroll: if it can't find where it left off, it asks you to scroll back.
- On x.com everything is in one 🤖 button (bottom left, shows replies today). Tap it for the menu.
  On phone-sized windows it sits above X's bottom bar. Hidden in the working window.
- Control center works at phone width.
- "AI calls today" counter at the top (watch Gemini's free daily limit).
- Video frames are only grabbed when the post's text doesn't explain the video, and dropped after use.
- Replies read for context skip ads and your own replies. AI requests time out after 45 s instead of hanging.

CHANGES IN 2.3: reply styles
- Two styles, from your one-week data:
  OPINION: a bold one-line stance, optionally a second line with a sarcastic punchline about one detail. Under 30 words.
  REACTION: one short casual line about one specific detail.
- Control center > AI > Reply style: Auto (AI picks per post: debate → opinion, funny / clip → reaction), Opinion only, Reaction only.
  Each review card shows its style and has "Rewrite as opinion / reaction". The bar above the list shows the mix (aim 60–70% opinion).
- The ✨ Reply ideas button uses the same prompts and style setting.
- Punctuation rules: max 1–2 marks per sentence, no semicolons / colons / dashes, "..." welcome.
- Reviewer and the free local check now mark down hedging ("anyways", "I think"), preaching, empty compliments, "Honestly" openers,
  "it's not X it's Y", too much punctuation and replies that are too long. Short and funny is never marked down.
- If Grok's reply is among the replies read, it's passed to the writer as "Grok's explanation".
- Gemini model unchanged: gemini-3.1-flash-lite (free tier).

CHANGES IN 2.3.1: fewer Gemini calls
- No Claude key: the reviewer is skipped (free local check only) instead of making a second Gemini call. 2 Gemini calls per post max.
- Gemini writes one post at a time, not two at once.
- "High demand" from Gemini: 3 tries with longer waits (8 s, 20 s) instead of 4 quick ones; two busy posts in a row pause writing
  and keep the posts in the queue. Press Write replies again in a few minutes.
- Context trimmed to 6 replies (200 characters each) so each request stays small.
- "AI calls today" now counts every request, retries included.

CHANGES IN 2.3.2
- ✨ Reply ideas on a post: one AI call, 3 replies, no AI reviewer (you review it yourself). The free local check
  just puts the most human-sounding one first. The AI reviewer is only used in Autopilot batches.

CHANGES IN 2.3.3
- Clicking ✨ Reply ideas (or New ideas) again while it's still writing no longer sends another AI call.
- A wrong key or bad request fails after 1 call instead of retrying 3 times. Only "busy" errors are retried.
