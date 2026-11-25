-- The four games as config/games.json has them, so the dashboard has its tabs
-- before the first sync runs. Every sync run upserts the same rows from that
-- file, which stays the source of truth.
select public.dashboard_sync_games('[
  {"slug": "pearl-tide", "display_name": "Pearl Tide", "status": "live",
   "ios_bundle_id": "com.pearltide.swim", "android_package_id": "com.pearltide.swim",
   "config": {"platforms": {"ios": {"status": "live"}, "android": {"status": "in_review"}}, "community_label": "Reef Runway"}},
  {"slug": "chillwater-lake", "display_name": "Chillwater Lake", "status": "in_review",
   "ios_bundle_id": "com.lakeangler.game", "android_package_id": "com.lakeangler.game",
   "config": {"platforms": {"ios": {"status": "in_review"}, "android": {"status": "prelaunch"}}, "community_label": "Leaderboards"}},
  {"slug": "game-3", "display_name": "Game 3", "status": "prelaunch",
   "config": {"platforms": {"ios": {"status": "prelaunch"}, "android": {"status": "prelaunch"}}}},
  {"slug": "game-4", "display_name": "Game 4", "status": "prelaunch",
   "config": {"platforms": {"ios": {"status": "prelaunch"}, "android": {"status": "prelaunch"}}}}
]'::jsonb);
