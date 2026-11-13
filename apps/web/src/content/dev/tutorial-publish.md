---
title: "Publish your mod on TM Horizon"
group: "tutorials"
order: 3
synced: false
note: "The portal is running on a staging server and is not public yet. Signatures and some review steps are still being finished, see Publishing mods."
---

This is the whole way from a GitHub repository to a mod page that players can install from the launcher. It takes about ten minutes if your release is already on GitHub.

You need: a GitHub repository with at least one release that has the mod as a zip (or a TMLoader server), and a GitHub or Discord account.

## 1. Log in

Open the developer portal and log in with Discord or GitHub. There is no password and no separate account.

![The login page of the developer portal](/img/dev/publish-1-login.webp)

Log in with the GitHub account that owns the repository. Then the claim in step 7 is automatic.

## 2. Look at My projects

After the login you land on **My projects**. If your mod is already in the TM Horizon catalog, it is listed here as unclaimed and you can claim it (step 7). If not, it is empty.

![My projects](/img/dev/publish-2-projects.webp)

## 3. New project

Click **New project** and paste the link of your GitHub repository (or the URL of your TMLoader server). Click **Preview**. The hub reads the repository and shows what it found. It does not import anything yet. No tokens, keys or workflows are needed in your repository.

![New project: paste the repository](/img/dev/publish-3-new-project.webp)

If you prefer, **Create by hand** gives you the empty form.

## 4. Check the import preview

The preview lists what the hub found: the type, name and summary, the README as description, pictures from the README, the licence, links, the newest release with its files, and a `showcase.json` if the repository has one. Every item has a checkbox. Only what is checked is imported.

![Import preview: type, name, description, pictures](/img/dev/publish-4-import-preview.webp)

Things to check:

- **Type** is required. It decides how the launcher offers the project: a mod is installed into the game, a tool or an Openplanet plugin is linked or offered as a download. Pick the one that fits.
- **Games and install**: tick the games the mod works with. For each game choose how the files are installed (for example "TMLoader product" or "files next to the game"). When you picked a release with several files, choose the right one.
- **Pictures**: the first becomes the gallery, one can be the banner (wide, at least 640 x 160).
- The box "What will be imported" at the bottom shows the result. **Import** is greyed out until at least one game is chosen.

After the import the hub watches your repository and picks up new releases by itself.

## 5. Fill in the details

The project page has tabs: **Details**, **Images**, **Showcase**, **Versions**, **Sources**, **Team** and **Analytics**. Details is where you set the type, name, summary, description (Markdown with a live preview), games and install settings, categories and tags, licence and links.

![The Details tab](/img/dev/publish-5-details.webp)

Keep the summary to one or two sentences (10 to 200 characters). It is the line under the name in lists.

## 6. Make a showcase page

The **Showcase** tab builds the page that players see for your mod: hero picture, features, screenshots, video, hotkeys, compatibility and buttons. It is data, not HTML, so it looks the same on the website and in the launcher. Start from the template, change the texts, add your pictures, and check the preview.

![The Showcase tab](/img/dev/publish-6-showcase.webp)

Pictures must be on an allowed host: the hub's own storage (upload them in the Images tab), `raw.githubusercontent.com` (files in your repository), GitHub release assets or `i.imgur.com`. Pictures that only exist as attachments in a GitHub issue or README (`github.com/user-attachments/...`) are not accepted: commit them to the repository or upload them.

You can also keep the showcase in your repository as `showcase.json`. The format is in [Showcase pages](/dev/docs/showcase/).

## 7. Claim an existing project

A mod that is already in the catalog starts unclaimed. Open it in My projects and claim it. If you log in with the GitHub account that owns the repository, or the TMLoader token proves it, the claim is approved automatically. Otherwise a moderator checks the claim against public evidence, for example a post from your known account. After a claim, the next versions of the project go to review for 14 days. See [Review, claims and appeals](/dev/docs/review-and-claims/).

## 8. Release a new version

Make a new release on GitHub. The hub checks the repository regularly and creates a version from it. New versions can wait in review for up to an hour, longer for a first release or a changed owner. Players get the update in the launcher. The **Versions** tab shows the state, the **Analytics** tab the downloads.

## 9. Look at the public page

Your project has a public page on the website and in the launcher, with your showcase on top.

![The public page](/img/dev/publish-7-public-page.webp)

## Next

- Publishing rules and the checks: [Publishing mods](/dev/docs/publishing/).
- More than a download: [Horizon scripts](/dev/docs/tutorial-first-script/) and [plugins](/dev/docs/tutorial-first-plugin/).
- Run it on more games: [Port a mod to ESWC, Sunrise or Original](/dev/docs/tutorial-crossover/).
