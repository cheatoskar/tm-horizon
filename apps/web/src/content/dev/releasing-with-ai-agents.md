---
title: "Releasing with AI coding agents"
group: "publish"
order: 6
synced: false
note: "Written for coding agents (Claude Code, Codex, Cursor and similar) that work in your repository. They need no special tool and no MCP server: a normal GitHub release is the interface."
---

If an AI coding agent helps you ship your mod, give it one job: **make a clean GitHub release**. TM Horizon does the rest. There is nothing to install for the agent and no TM Horizon account to hand over.

## The flow

1. Your repository is connected to a project in the [developer portal](/dev/docs/tutorial-publish/) once (a person does this, it takes a minute).
2. The agent bumps the version, updates the changelog and keeps `showcase.json` valid.
3. The agent creates a GitHub release with the mod zip attached (`gh release create`).
4. The hub notices the release, copies the file, checks it and publishes it.

How the hub notices: it reads the releases of every connected GitHub repository by itself, about every 20 minutes for repositories that release often and every few hours for quiet ones. With the optional GitHub App installed on the repository it is told **instantly** by a webhook instead. Either way nobody has to upload anything.

## What TM Horizon does with a release

- Takes the release file that matches the pattern it remembered from your first release (the first time it may ask you to pick one when several zips fit).
- Runs the automatic checks: malware scan, a diff against the previous version (new DLLs, new network or process access, size jumps), metadata sanity.
- **First version of a project, an owner change, and anything the checks flag go to a human review.** Players do not see them before that.
- A clean update of a project that is already published waits a short hold (60 minutes by default) so you can stop a bad release, then goes live. The launcher offers it to players who have the mod.

So a release the agent makes is never silently published past the checks, and you can always see and stop it in the portal. See [Review, claims and appeals](/dev/docs/review-and-claims/) for the findings and what they mean.

## Snippet for CLAUDE.md or AGENTS.md

Copy this into the file your agent reads at the start of a session. Replace the names in capitals.

````markdown
## Releasing (TM Horizon)

Releases go through GitHub. TM Horizon picks up new GitHub releases of this repository by itself,
so never upload the mod anywhere else and never ask for credentials.

To release version X.Y.Z:

1. Ask me for the version number if I did not give one. Use semver: 1.2.0, or 1.2.0-beta.1 for a beta.
2. Bump the version everywhere it appears (VERSION_FILES: for example plugin.json, info.toml,
   description.yaml, package.json). The version in the files must equal the release tag without the "v".
3. Add a section for the version to CHANGELOG.md. Write it for players: what changed in the game.
   The first lines of that section become the release notes.
4. If showcase.json exists, keep it valid: only the documented blocks and fields, https links only,
   image paths that exist in the repository. Rules and the block list:
   in the TM Horizon developer docs, page "Showcase pages" (/dev/docs/showcase/). The portal's Showcase tab
   validates live: paste the file there when you are unsure. Unknown fields are errors.
5. Build the mod zip (BUILD_COMMAND). The zip is what players get: no source, no .pdb, no
   test files, and no program (.exe) unless the project is a tool that needs one.
6. Commit "Release X.Y.Z" and push to the default branch.
7. Create the release with the zip and the notes, as a pre-release for betas:

       gh release create vX.Y.Z dist/MODNAME-X.Y.Z.zip --title "MODNAME X.Y.Z" --notes-file RELEASE_NOTES.md
       gh release create vX.Y.Z-beta.1 dist/MODNAME-X.Y.Z-beta.1.zip --prerelease --notes-file RELEASE_NOTES.md

   Attach exactly one zip per game or browser if the mod has separate builds, and put the game in the
   file name (MODNAME-X.Y.Z-tmnf.zip).
8. Tell me the release URL. TM Horizon then checks the file; a first version or a change of owner
   waits for a human review, so it can take a while before it shows in the launcher. Do not retry,
   do not delete and re-create the release to speed it up.

Never: publish on my behalf anywhere else, create API tokens, or put tokens or passwords into the
repository, the release notes or the changelog.
````

The tag may carry a leading `v` (`v1.2.0`); the hub reads the version from the tag. GitHub pre-releases become the **beta** channel.

## Without GitHub: API tokens

If your project does not live on GitHub (or you build in a private repository), you can upload with a script or CI job using a hub **API token**.

- Tokens are created by a person in the portal under **Account > API tokens**. An agent cannot create one: the hub refuses token creation from a token.
- A token has scopes. `versions:write` uploads versions, `projects:read` lists your projects. Give it only what the job needs.
- **Scope it to one project** (the token then works for that project only) and give it an expiry (up to 365 days, default 180). It is shown once; if it leaks, revoke it in the portal and it stops working at once.
- Publishing rights stay with you: the token only uploads a *version*. It cannot change the project page, the team or other projects, and everything it uploads goes through the same checks and review as any other version.

Upload a version (`$HUB` is the hub's address, the same host the portal runs on):

```bash
curl -X POST "$HUB/v1/projects/my-mod/versions" \
  -H "Authorization: Bearer $TMHORIZON_TOKEN" \
  -F "file=@dist/MyMod-1.2.0.zip" \
  -F 'meta={"version":"1.2.0","channel":"stable","changelog":"Fixes the night sky banding."}'
```

`meta` is JSON: `version` (like `1.2.0` or `1.2.0-beta.1`), `channel` (`stable` or `beta`, default `stable`), `changelog` (text, up to 20 000 characters) and optionally `installs` (defaults to the project's) and `signature`. The answer is the created version with its status (`held`, `review` or `published`). More uploads than 20 an hour are refused.

List the projects the token can see:

```bash
curl -H "Authorization: Bearer $TMHORIZON_TOKEN" "$HUB/v1/me/projects"
```

The calls and the exact fields are in the [Public API](/dev/docs/public-api/) page and its OpenAPI document.

### For the agent

Put the token in the CI secret store (`TMHORIZON_TOKEN`), never in the repository. In the CLAUDE.md snippet above, replace step 7 with the `curl` call and add the line "The token is in the environment variable TMHORIZON_TOKEN; never print it".

## Recommended: keep the rights with the author

- The author owns the GitHub repository and the TM Horizon project. The agent works in a branch or on the author's machine and uses the author's `gh` login, or a CI job with the repository's own token.
- Prefer a GitHub release over an API token: nothing secret is shared and the release stays visible on GitHub.
- If you do use a token: one project, only `versions:write`, short expiry, revoke it when the job is done or the agent changes.
- Check what an agent released: the project in the portal shows every version and its review state. You can cancel a held version before it goes live.
