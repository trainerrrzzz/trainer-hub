#!/usr/bin/env bash
# The GitHub settings the factory relies on (ADR-016), applied from versioned files. Idempotent: run it again after
# changing a file. Needs a token with admin rights on the repo.
#
#   github-settings.sh apply      the ruleset for main (.github/rulesets/main.json), then the merge settings in
#                                 .github/repo-settings.json, the `release` environment (.github/environments/release.json:
#                                 the owner approves every deployment, only main deploys; E017) and the labels
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { usage_of "$0"; }

need_cmd gh
need_cmd jq
REPO="$(repo_slug)"
RULESET="$ROOT/.github/rulesets/main.json"
SETTINGS="$ROOT/.github/repo-settings.json"
RELEASE_ENV="$ROOT/.github/environments/release.json"

apply_ruleset() {
  local name id
  name="$(jq -r .name "$RULESET")"
  id="$(gh api "repos/$REPO/rulesets" | jq -r --arg name "$name" '[.[] | select(.name == $name)][0].id // empty')"
  if [ -n "$id" ]; then
    gh api --method PUT "repos/$REPO/rulesets/$id" --input "$RULESET" >/dev/null
    echo "✅ ruleset '$name' updated"
  else
    gh api --method POST "repos/$REPO/rulesets" --input "$RULESET" >/dev/null
    echo "✅ ruleset '$name' created"
  fi
}

apply_merge_settings() {
  jq .merge "$SETTINGS" | gh api --method PATCH "repos/$REPO" --input - >/dev/null
  echo "✅ merge settings: $(jq -r '.merge | to_entries | map("\(.key)=\(.value)") | join(", ")' "$SETTINGS")"
}

# The `release` environment holds the signing keys and API keys of the release lanes (E017 AC7). The owner is its required
# reviewer; deployments are allowed from main only, by a custom branch policy for each branch in the file. Admins can't
# bypass the rules: agents run with the owner's admin token, and a bypass would let them deploy without the owner's approval.
apply_release_environment() {
  local name login id reviewers='[]' policies branch policy_id
  name="$(jq -r .name "$RELEASE_ENV")"
  while IFS= read -r login; do
    id="$(gh api "users/$login" --jq .id)"
    reviewers="$(jq -c --argjson id "$id" '. + [{type: "User", id: $id}]' <<<"$reviewers")"
  done < <(jq -r '.reviewers[]' "$RELEASE_ENV")
  jq --argjson reviewers "$reviewers" \
    '{reviewers: $reviewers, prevent_self_review, can_admins_bypass, deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}' \
    "$RELEASE_ENV" | gh api --method PUT "repos/$REPO/environments/$name" --input - >/dev/null
  policies="$(gh api "repos/$REPO/environments/$name/deployment-branch-policies" --jq '.branch_policies[] | [.id, .name] | @tsv')"
  while IFS=$'\t' read -r policy_id branch; do
    [ -n "$policy_id" ] || continue
    jq -e --arg branch "$branch" '.deployment_branches | index($branch)' "$RELEASE_ENV" >/dev/null \
      || gh api --method DELETE "repos/$REPO/environments/$name/deployment-branch-policies/$policy_id" >/dev/null
  done <<<"$policies"
  while IFS= read -r branch; do
    ! cut -f2 <<<"$policies" | grep -qxF -- "$branch" || continue
    jq -n --arg name "$branch" '{name: $name, type: "branch"}' \
      | gh api --method POST "repos/$REPO/environments/$name/deployment-branch-policies" --input - >/dev/null
  done < <(jq -r '.deployment_branches[]' "$RELEASE_ENV")
  echo "✅ environment '$name': reviewers $(jq -r '.reviewers | join(", ")' "$RELEASE_ENV"), deploys from $(jq -r '.deployment_branches | join(", ")' "$RELEASE_ENV") only"
}

apply_labels() {
  local name color description
  while IFS=$'\t' read -r name color description; do
    gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null
    echo "🏷  label $name"
  done < <(jq -r '.labels[] | [.name, .color, .description] | @tsv' "$SETTINGS")
}

case "${1:-}" in
  apply) [ $# -eq 1 ] || usage; apply_ruleset; apply_merge_settings; apply_release_environment; apply_labels ;;
  *) usage ;;
esac
