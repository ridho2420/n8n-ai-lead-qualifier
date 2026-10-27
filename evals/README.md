# Consistency test

The AI step judges one thing per lead: does the request fit the agency's services (need fit 0, 12 or 25), is it spam, is it a job seeker. Everything else in the score is calculated by code. This test checks how stable that AI judgment is when the same 12 leads are scored several times with the same prompt and settings.

## What is tested

- The 12 fictional leads in [`../sample-data/test-leads.json`](../sample-data/test-leads.json), always in the same order.
- Only the scoring steps: **AI: Assess Need** and **Combine Score**. HubSpot, Slack and Gmail do not run.
- Model `gemini-3.5-flash-lite`, temperature 0, prompt unchanged between runs.

The expected result for every lead is in [`expected-results.csv`](expected-results.csv). Budget, timeline and company size points come from the fixed scoring table. The expected need fit was set by hand before the test. The checker refuses to run if a row in that file does not add up under the scoring rules.

## Measures

Set before the first run:

| Measure | What it shows |
|---|---|
| Category as expected | Did each lead land in hot, warm or cold as expected (runs × 12) |
| Need fit as expected | Did the AI give the expected 0, 12 or 25 |
| Spam and job seeker flags as expected | Did the AI flag the right leads |
| Score exactly as expected | Final score equal to the expected score |
| Leads with the same score in every run | How stable the AI is, regardless of whether it matches my expectation |
| Largest score difference for one lead | The worst case across runs |
| Leads that changed category between runs | The changes that would reach a salesperson |

For lead 10 (job seeker) and lead 11 (spam) the need fit does not change the score, because the special rules override it. Their need fit is still counted.

## Run it again

1. In n8n, open the workflow with the 12 test leads pinned on **Lead Form**.
2. For each run: **Execute step** on **AI: Assess Need**, then **Execute step** on **Combine Score**. Wait about a minute between runs (Gemini free tier: 15 requests per minute).
3. Save each run's **Combine Score** output as one file in `evals/runs/`: the node's output items as JSON, or a CSV with the columns `lead, need_fit, is_spam, is_job_seeker, lead_score, lead_category`. This folder is ignored by git because the raw output contains the test inbox address.
4. Run the checker:

```
node evals/check-consistency.js evals/runs --out evals/results
```

It prints the measures and a table per lead, and writes:

- `results/consistency-results.csv`: every run and lead, without email addresses or raw input
- `results/consistency-summary.md`: the measures as a table
- `results/consistency-for-sheets.csv`: one row per lead with every run's score, for a spreadsheet

The checker needs Node 18 or newer and has no dependencies. It also flags a run with missing leads, rows in the wrong order, a failed AI call, or a score that does not follow the scoring rules.

## Results

Run on 26 and 27 October 2026 with n8n 2.35.7: 5 runs × 12 leads, same prompt and settings in every run.

| Measure | Result |
|---|---|
| Category as expected | 60 of 60 |
| Need fit as expected | 60 of 60 |
| Spam and job seeker flags as expected | 60 of 60 |
| Score exactly as expected | 60 of 60 |
| Leads with the same score in every run | 12 of 12 |
| Largest score difference for one lead | 0 points |
| Leads that changed category between runs | none |

Every lead got the same need fit, flags, score and category in all 5 runs, and every result matched the expected results. Per-run data: [`results/consistency-results.csv`](results/consistency-results.csv).

**The reason text was not identical.** No lead got the same wording in all 5 runs (3 to 5 versions per lead), even at temperature 0. All 60 reasons were reviewed: each one matched the lead's input, stayed under the 35-word limit and started with the person's first name (or `SPAM:`). This is why the score and category are built from fixed values and code, and the reason is only shown to sales as context.

**How the runs were made.** Run 1 used *Execute step* on the two scoring nodes in the n8n editor (executions 352 and 353). Runs 2 to 5 were test runs started through n8n's MCP server, with HubSpot, Slack, Gmail and Google Sheets replaced by simulated data and Gemini called for real (executions 354 to 357). Every run made 12 Gemini calls, each with its own token count, and none failed. Gemini took 11 to 29 seconds per lead in the evening run and 1 to 4 seconds per lead in the morning runs.

**Limits.**

- 12 leads is a small set, and most of them are clear cases on purpose. A borderline request may be judged less consistently.
- Lead 3 (75, hot) is the one lead where a single change in need fit (25 to 12) would move it to warm. It did not change in any run.
- The test shows the AI step is stable on these leads. It does not show that the expected need fit is the right business call, and it does not compare against letting the AI score everything.
