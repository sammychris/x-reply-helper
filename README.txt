SAMMY'S REPLY HELPER FOR X  (Chrome extension, Windows PC)

WHAT IT DOES
- Adds a "Reply ideas" button under every post on x.com.
- Click it: it reads the post's text and images, then shows 3 reply ideas in your voice.
- You can edit an idea right in the box, then press "Use": it opens X's reply box and types it in.
- YOU press X's Reply button. Nothing is ever posted on its own.
- A second AI (the reviewer) checks the 3 drafts against the post, scores them, puts the best on top
  and greys out any that misread the post or are too generic. Turn it off in Settings to save money.
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
