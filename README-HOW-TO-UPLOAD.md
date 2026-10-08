# Bringing GitHub `main` up to date (everythingshul/ecards)

The last two zips were uploaded as whole folders, so their files landed at
`delivery6/…` and `delivery7/…` in the repo root instead of replacing the real
files (`src/…`, `frontend/…`). That is why none of those changes went live.

This zip has NO wrapper folder: its top level is `src/` and `frontend/`,
exactly like the repo root. It contains every file that differs between
GitHub `main` (as of commit b7b59ce) and the current, tested code — all of:

- Round "4 fixes": store password reset, Brevo bounce notifications
  (new file src/routes/emailEvents.js), Enter-Portal bypass of the billing
  code, store login email sync + single-address validation
- Signature-canvas fix (blank drawn signatures) and "First Last" card search
- Editable bank list (+ Metropolitan Bank) and "Download Store Bank Details"

## Steps (GitHub web UI)

1. Delete the junk that got uploaded by mistake — open each and use the
   trash icon ("Delete directory" / "Delete file"), commit to main:
   - `delivery6/`  (whole folder)
   - `delivery7/`  (whole folder)
   - `applicants.html` (the stray copy in the repo ROOT — NOT frontend/admin/applicants.html)
2. Unzip this file on your computer.
3. On GitHub, open the repo root → "Add file" → "Upload files".
4. Drag the `src` and `frontend` FOLDERS (the two folders themselves, from
   inside the unzipped directory) onto the upload area. GitHub keeps the
   folder structure, so `src/db.js` replaces `src/db.js`, and so on.
   Do NOT drag the unzipped parent folder, and do not drag this README.
5. Commit directly to main. Your host redeploys from main as usual.

After step 5 the repo matches the tested code exactly (`git diff` is empty).

## To never need this again
Install the Claude GitHub App on the everythingshul org for this repo
(https://github.com/apps/claude/installations/select_target) or reconnect
GitHub under claude.ai → Settings → Connectors. Then I can push commits
directly instead of sending zips.
