// Triggers the GitHub Actions sync workflows on Cloudflare's cron schedule,
// because GitHub's own schedule trigger is best-effort and drops hourly runs.

export const SCHEDULE = {
  '7 * * * *': 'sync-hourly.yml',
  '20 2,14 * * *': 'sync-daily.yml',
};

export async function dispatchWorkflow(workflow, env, fetchImpl = fetch) {
  const token = String(env.GITHUB_TOKEN || '').trim();
  const repo = String(env.GITHUB_REPO || '').trim();
  const ref = String(env.GITHUB_REF || 'main').trim();
  if (!token) throw new Error('Missing GITHUB_TOKEN secret');
  if (!repo) throw new Error('Missing GITHUB_REPO variable');

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'abyssol-sync-cron',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`GitHub dispatch for ${workflow} failed (${res.status}): ${detail}`);
  }
  return { workflow, repo, ref, status: res.status };
}

export default {
  async scheduled(controller, env) {
    const workflow = SCHEDULE[controller.cron];
    if (!workflow) throw new Error(`Unknown cron expression: ${controller.cron}`);
    await dispatchWorkflow(workflow, env);
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
