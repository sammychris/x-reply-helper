// Autopilot settings shared by the control center page and the x.com helper.
// Your own changes are saved in Chrome (storage "apSettings") on top of these.
self.AP_DEFAULTS = {
  batchSize: 20,
  keepGoing: false,

  // choosing posts: filters only run when you turn them on
  useFilters: false,
  filters: { age: false, replies: false, words: false, accounts: false, topics: false, types: false, ads: true, own: true },
  favFirst: true,
  topics: [],
  keywords: "",
  types: { text: true, image: true, video: true },
  maxAgeHours: 6,
  maxReplies: 100,
  skipWords:
    "politics, political, election, vote, senate, president, tinubu, trump, apc, pdp, religion, church, mosque, pastor, imam, " +
    "giveaway, give away, airdrop, follow for follow, f4f, follow back, gain followers, link in bio, onlyfans, nft, " +
    "rip, rest in peace, rest in power, passed away, condolences",
  skipAccounts: "",
  favAccounts: "",
  myHandle: "sammychrise",

  // what to do with each kind of post (you can change any single post in the queue)
  defaultActions: {
    feed: { reply: true, like: false, repost: false },
    picked: { reply: true, like: true, repost: false },
    link: { reply: true, like: false, repost: false },
    group: { reply: false, like: true, repost: true }
  },

  // speed: "finish" = do the whole batch in finishMinutes, gaps vary post to post; "gap" = random gap + rests
  paceMode: "finish",
  finishMinutes: 10,
  minGap: 8,
  maxGap: 20,
  restEvery: 10,
  restMinutes: 3,

  // reading posts
  readReplies: true,
  images: true,
  videoFrames: true,
  grok: false,
  grokPerDay: 40,

  // AIs
  reader: "gemini", // who describes pictures and video frames
  writer: "gemini",
  reviewer: "claude",
  passScore: 6,
  autoUntick: false, // off = every post comes ticked on the review screen; you decide
  bannedWords:
    "aesthetic, delve, elevate, game-changer, game changer, resonate, resonates, vibe check, testament, tapestry, captivating, " +
    "unleash, embark, realm, elevated, seamless, absolutely, great point, so true, couldn't agree more, spot on, well said, " +
    "love this, this is everything, truly, journey, in today's world, a must-watch, hits different"
};

self.AP_TOPICS = {
  movies: { label: "Movies", words: ["movie", "movies", "film", "films", "cinema", "netflix", "trailer", "actor", "actress", "director", "scene", "oscar", "box office", "sequel", "marvel", "horror", "watched"] },
  aivideo: { label: "AI video", words: ["ai video", "ai film", "kling", "veo", "sora", "runway", "pixverse", "seedance", "wan", "hailuo", "minimax", "midjourney", "higgsfield", "generated", "text to video", "image to video", "ai art"] },
  filmmaking: { label: "Filmmaking", words: ["filmmaking", "filmmaker", "cinematography", "shot", "editing", "edit", "camera", "lens", "vfx", "screenplay", "script", "storyboard", "short film"] },
  nollywood: { label: "Nollywood & Africa", words: ["nollywood", "nigeria", "nigerian", "naija", "lagos", "african", "africa", "afrobeats", "ghana", "kenya"] },
  tech: { label: "Tech & coding", words: ["coding", "code", "developer", "dev", "javascript", "python", "software", "startup", "claude", "gpt", "gemini", "cursor", "vibe coding", "app", "ai"] },
  creator: { label: "Creator life", words: ["creator", "content", "followers", "engagement", "monetization", "views", "algorithm", "impressions", "posting", "viral"] }
};
