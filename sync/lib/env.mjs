// Which environment variable a game's setting comes from.

/** `<PREFIX>_<NAME>` only: for values that belong to one game (a RevenueCat key, a project id, a database URL). */
export const ownEnv = (env, game, name) => env[`${game.env_prefix}_${name}`] || '';

/** `<PREFIX>_<NAME>`, else the shared `<NAME>`: for accounts that cover every game (Apple, Google, PostHog). */
export const sharedEnv = (env, game, name) => env[`${game.env_prefix}_${name}`] || env[name] || '';
