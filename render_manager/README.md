# GitHub Render Queue

A small local Mac GUI for sending one or more render zip files to the universal GitHub Actions renderer.

## Run

From the universal renderer repo:

```bash
python3 render_manager/render_manager.py
```

## What it does

- Lets you select multiple `.zip` render packages.
- Lets you drag and drop `.zip` packages using the drag/drop component bundled with the app; no separate installation is needed.
- Gives every row a clickable Selected checkbox. Uncheck a row to leave it out of publishing, removal, copying, or downloading actions.
- Assigns checked waiting zips unique release tags from `v1` to `v10`.
- Treats Total workers as one budget and divides it evenly across the checked waiting jobs.
- Removes local queue rows using their checked Publish boxes.
- Clears renderer releases `v1` to `v10`, workflow jobs, and their attached artifacts with one **Clear all** action.
- Uploads all selected release zips concurrently, then dispatches all of their `.github/workflows/render-release.yml` jobs.
- Saves each GitHub run ID immediately. You can close the app, reopen it later, and use **Refresh jobs** to update every submitted row and discover finished artifacts.
- Copies the download link for the single highlighted completed row.
- Downloads all checked completed rows in bulk.
- Opens checked artifact downloads in Brave one at a time so its Neat Download Manager extension can intercept every link.
- Downloads checked completed jobs to a persistent chosen folder, extracts their MP4 files, and deletes the downloaded artifact ZIP files automatically.

## Token

On first launch, enter your GitHub username and token. The app tries to store the token in macOS Keychain. If that is unavailable, it stores it under your local Application Support folder, outside the repo.

Recommended token permissions:

- Contents: read/write
- Actions: read/write
- Metadata: read

For classic tokens on a private repo, `repo` scope is enough.

## Local state

Settings and queue history are saved outside this repo:

`~/Library/Application Support/GitHub Render Queue/`

Do not commit tokens or local state files.
