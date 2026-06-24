# How to enable the RegKit PR gate in your repo

Copy `regkit.yml` from this folder into your repository at:

    .github/workflows/regkit.yml

That's it. On the next pull request, RegKit will scan changed code, post a
compliance report as a PR comment, and block the merge if any BLOCK-level
violations are found.

Optional: to enable live AGENT-3 legal reasoning (Claude), add your
Anthropic API key as a repo secret named ANTHROPIC_API_KEY under
Settings → Secrets and variables → Actions. Without it, RegKit still runs
with AGENT-3 in mock mode.
