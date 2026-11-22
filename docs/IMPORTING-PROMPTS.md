# Importing master prompts

This guide is for admins adding prompts to PromptVault, one at a time or in bulk from a spreadsheet or JSON file.

**Where:** sign in with an admin account, open **Admin → Add prompts** (or go to `/?v=admin`).

- **One prompt:** fill in the form and press **Add prompt**. It's live immediately.
- **Bulk import:** upload a CSV or JSON file (up to 1,000 prompts), press **Check file**, review the results, then press **Import**.

Nothing from a file is saved until you press **Import**, and running the same file twice never creates duplicates.

---

## 1. Columns

| Column | Required | What it is |
|---|---|---|
| `title` | Yes | Short name shown in the list. Up to 120 characters. |
| `masterPrompt` | Yes | The prompt itself, 10 to 8,000 characters. Line breaks are kept. See [fill-in fields](#2-fill-in-fields). |
| `category` | Yes, or set a default | Filter group inside a collection, e.g. `Sales`, `AI Photo`. Up to 60 characters. |
| `collection` | Yes, or set a default | Top-level library, e.g. `Product Management`. Use an existing name to add to it; a new name creates a new collection. Up to 60 characters. |
| `tool` | No | The AI it's written for, e.g. `ChatGPT`, `Claude`, `Nano Banana`. Defaults to `Any AI`. |
| `useCases` | No | Search keywords. In CSV, separate them with `\|`. In JSON, use a list. The category is added automatically. Up to 20. |
| `section` | No | Finer grouping under the category. Defaults to the category. |
| `viralScore` | No | 0 to 100, a starting ranking signal. Leave it empty unless the prompt is proven popular; votes and copies take over from there. |

**Other spellings are accepted.** Column names aren't case-sensitive, and spaces, `_` and `-` are ignored, so `Master Prompt`, `master_prompt` and `prompt` all work. Accepted aliases:

- `title`: `name`
- `masterPrompt`: `prompt`, `text`, `prompt text`
- `tool`: `model`, `ai`
- `useCases`: `tags`, `keywords`
- `section`: `subcategory`
- `viralScore`: `score`

Any other column is ignored, and the check shows a warning so you can spot typos.

**Defaults.** The import screen has default **collection**, **category** and **tool** fields. They're used for any row that leaves that column empty, which is handy when a whole file goes into one collection.

## 2. Fill-in fields

Anything the user should replace goes in **square brackets**:

```
Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE].
```

Each bracket becomes a fill-in box in the prompt view, and the prompt updates as the user types. Both styles work: `[TOPIC]` and `[product name]` (shown to the user as "Product name"). Using the same bracket twice fills both places.

- Use **square brackets only.** `{{topic}}` and `<topic>` won't become fill-in fields; the check warns about `{{curly}}` placeholders.
- A prompt with no brackets is allowed (users copy it as is), but the check flags it in case you forgot them.
- Keep names short and clear: `[PRODUCT]`, not `[the product you are selling right now]`.

## 3. CSV files

Use this for spreadsheets. In Excel choose **File → Save As → CSV UTF-8**. In Google Sheets choose **File → Download → Comma-separated values**.

```csv
title,masterPrompt,category,collection,tool,useCases
LinkedIn hook writer,"Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE]. Each under 12 words.",Writing,Creator Toolkit,ChatGPT,linkedin | hooks | personal brand
Cold email opener,"Write a cold email to [PROSPECT_ROLE] at [COMPANY] about [OFFER].
Keep it under 90 words and end with one clear question.",Sales,Creator Toolkit,Claude,cold email | outreach
```

Rules (spreadsheet apps handle these automatically; they matter if you write CSV by hand):

- The **first row is the header** with column names. Every following row is one prompt.
- A value containing a **comma, a line break or a quote** must be wrapped in double quotes: `"like, this"`.
- A **quote inside a quoted value** is written twice: `"Say ""hello"" first"`.
- **Lists** (`useCases`) are separated with `|`: `linkedin | hooks`. `;` also works.
- Empty rows are ignored.

## 4. JSON files

Use this when prompts come from a script or another app. The file is an array of objects; `{ "prompts": [ ... ] }` also works.

```json
[
  {
    "title": "LinkedIn hook writer",
    "masterPrompt": "Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE]. Each under 12 words.",
    "category": "Writing",
    "collection": "Creator Toolkit",
    "tool": "ChatGPT",
    "useCases": ["linkedin", "hooks", "personal brand"]
  },
  {
    "title": "Cold email opener",
    "masterPrompt": "Write a cold email to [PROSPECT_ROLE] at [COMPANY] about [OFFER].\nKeep it under 90 words and end with one clear question.",
    "category": "Sales",
    "collection": "Creator Toolkit",
    "tool": "Claude",
    "useCases": ["cold email", "outreach"]
  }
]
```

Write line breaks inside a prompt as `\n`. `useCases` can also be a single `"a | b"` string.

Both templates can be downloaded from the **Format guide** on the import screen.

## 5. What the check tells you

Every row gets one of three results:

| Result | Meaning | What happens on Import |
|---|---|---|
| **Ready** | Valid and new. | Added. |
| **Duplicate** | The same prompt text is already in the vault (in any collection), or appears earlier in this file. Spacing and capital letters don't count as differences. | Skipped. |
| **Error** | Something is missing or out of range; the message says what. | Skipped. |

Rows can also carry **warnings** (unknown column, no fill-in fields, `{{curly}}` placeholders). They're still imported; the warning is only there to help you catch mistakes.

To fix errors, correct the rows in your file and import the **whole file** again. The prompts that were already added show as duplicates and are skipped, so nothing is added twice.

Row numbers count prompts, not lines: row 1 is the first prompt after the header, even if an earlier prompt spans several lines.

## 6. After importing

- New prompts are **live immediately**: searchable, filterable and copyable by everyone.
- A new collection appears in the sidebar as soon as it has a prompt.
- **Recently added by admins**, under the import screen, lists what admins added, with a **Delete** button. Deleting removes the prompt for everyone, along with users' saves and votes on it.
- Built-in prompts (the original collections) can't be deleted from the panel.

## 7. Limits

- Up to **1,000 prompts per file** and **3 MB** per file. Split bigger libraries into several files.
- `masterPrompt` up to 8,000 characters; `title` up to 120.

## 8. For developers: the API

The panel uses one endpoint. It needs an admin session cookie, or `Authorization: Bearer $ADMIN_TOKEN` for scripts.

```bash
# Check only (nothing is written)
curl -X POST https://www.promptsvault.me/api/admin/prompts \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"dryRun": true, "defaults": {"collection": "Creator Toolkit"}, "prompts": [{"title": "…", "masterPrompt": "…", "category": "…"}]}'

# Import: the same body with "dryRun": false
```

The response is `{ dryRun, rows: [{ row, status, errors, warnings, title, collection, category, tool, variables, id? }], summary: { total, new, duplicate, invalid, imported } }`.

`GET /api/admin/prompts` lists admin-added prompts. `DELETE /api/admin/prompts/:id` deletes one. Validation lives in [server/src/admin-prompts.ts](../server/src/admin-prompts.ts); keep this guide in sync with it.
