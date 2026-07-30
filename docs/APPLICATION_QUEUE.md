# Terminal application queue

The terminal dashboard includes a local, reviewed application queue. It can prepare an eligible application in a headed browser and hand the completed employer form to you. It **never** clicks the employer's final Submit button.

## Prepare a reviewed item

Create an answers JSON file after reviewing the exact field values you want to use:

```json
{
  "answers": [
    { "selector": "#first_name", "type": "text", "value": "Jane" },
    { "selector": "#resume", "type": "file", "filePath": "/absolute/path/cv.pdf" }
  ]
}
```

Then add the evaluated role to the local queue:

```bash
node application-queue.mjs add 042 --answers /path/to/reviewed-answers.json --material /path/to/cv.pdf
```

Open the terminal dashboard and press `a` from the pipeline. Review the report, exact answers, and attachment hashes before pressing `y` to approve. Approval is single-use, bound to the immutable snapshot, and expires after 30 minutes.

## Safety behavior

- The queue, audit events, and browser profile are local user-layer data and are gitignored.
- Supported first-pass hosts are Greenhouse, Ashby, Lever, and Workday.
- Posting closure, CAPTCHA, MFA/login, form changes, unsupported controls, expired approval, or any receipt ambiguity stops at `NeedsUserAction`.
- After browser handoff, review the employer form and click Submit yourself. Confirmed receipt is required before the tracker can be marked Applied.
