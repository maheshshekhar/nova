#!/usr/bin/env bash
# Apply branch protection so NOTHING merges into main without the owner's review.
#
# Enforcement lives in GitHub settings (a workflow cannot block a merge). This
# script sets it via the GitHub CLI. Run once after creating the repo:
#
#   gh auth login            # if not already authenticated
#   ./.github/setup-branch-protection.sh
#
# What it enforces on `main`:
#   • no direct pushes — changes must come through a pull request
#   • at least 1 approving review, and a review from a CODEOWNER (you)
#   • stale approvals dismissed on new pushes; the last push must be approved
#   • the CI "verify" check must pass, and be up to date, before merge
#   • no force-pushes, no branch deletion, conversations must be resolved
#   • enforce_admins=false → you (admin/owner) can still merge after approving;
#     everyone else is fully gated until you approve.

set -euo pipefail

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
BRANCH="${1:-main}"

gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo "✅ Branch protection applied to ${REPO}@${BRANCH}"
